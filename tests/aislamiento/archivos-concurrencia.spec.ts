// Spec 012b (T4, rojo): concurrencia de generar contra las escrituras de ventas (excluir y restaurar incluidas) y contra las acciones de
// compras, en ambos ordenes y en carrera (10 rondas), sin interbloqueos (CA-7, CA-8, CA-10, CA-16; D4, D5, D6, D12; plan «Orden de
// bloqueo»: advisory `propuesta:{libro}:{periodo}:{cliente}` -> `{libro}_periodo` -> filas -> `archivo_generado`).
// Cada «generar» de aqui es la transaccion del worker armada con las funciones reales de @contapp/db (bloquear -> fijar estado ->
// leer filas -> ultima version -> insertar version); cada escritura es la del backend (advisory -> FOR SHARE -> escribir).
// Hasta T10 fallan por funcion inexistente. Contrato: encabezado de `archivos-soporte.ts`.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  barrera,
  conPlazo,
  montos,
  MONTOS_DG,
  type CompraLeida,
} from "./compras-soporte";
import {
  codigoRepo,
  contarEn,
  datosArchivo,
  entradaVersion,
  EscenarioArchivos,
  escrituraVentas,
  PeriodoGenerado,
  PERIODO,
  sostener,
  type Libro,
} from "./archivos-soporte";

const bloquearPeriodoLibro = (tx: Tx, c: string, p: string, l: Libro) =>
  exportado<(tx: Tx, c: string, p: string, l: Libro) => Promise<void>>(
    "bloquearPeriodoLibro",
  )(tx, c, p, l);
const fijarCompras = (
  tx: Tx,
  c: string,
  p: string,
  d: string,
  h: string,
  u: string,
) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      d: string,
      h: string,
      u: string,
    ) => Promise<unknown | null>
  >("fijarEstadoPeriodo")(tx, c, p, d, h, u);
const fijarVentas = (
  tx: Tx,
  c: string,
  p: string,
  d: string,
  h: string,
  u: string,
) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      d: string,
      h: string,
      u: string,
    ) => Promise<unknown | null>
  >("fijarEstadoPeriodoVentas")(tx, c, p, d, h, u);
const leerEstadoPeriodo = (tx: Tx, c: string, p: string) =>
  exportado<
    (tx: Tx, c: string, p: string, o: unknown) => Promise<{ estado: string }>
  >("leerEstadoPeriodo")(tx, c, p, { compartido: true });
const leerFilasReemplazo = (tx: Tx, c: string, p: string) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      f: (x: CompraLeida) => CompraLeida,
    ) => Promise<{ original: CompraLeida[]; vigente: CompraLeida[] }>
  >("leerFilasReemplazo")(tx, c, p, (x) => x);
const leerFilasReemplazoVentas = (tx: Tx, c: string, p: string) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      f: (v: { exclusion: unknown }) => { exclusion: unknown },
    ) => Promise<{ original: unknown[]; vigente: { exclusion: unknown }[] }>
  >("leerFilasReemplazoVentas")(tx, c, p, (v) => v);
const ultimaVersion = (tx: Tx, c: string, p: string, l: Libro) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      l: Libro,
    ) => Promise<{ version: number } | null>
  >("ultimaVersion")(tx, c, p, l);
const insertarVersion = (tx: Tx, v: ReturnType<typeof entradaVersion>) =>
  exportado<(tx: Tx, v: unknown) => Promise<{ version: number }>>(
    "insertarVersion",
  )(tx, v);
const excluirVenta = (
  tx: Tx,
  d: {
    clienteId: string;
    periodo: string;
    ventaId: string;
    motivo: string;
    usuarioId: string;
  },
) =>
  exportado<(tx: Tx, d: unknown) => Promise<unknown | null>>("excluirVenta")(
    tx,
    d,
  );
const restaurarVenta = (tx: Tx, v: string, u: string) =>
  exportado<(tx: Tx, v: string, u: string) => Promise<boolean>>(
    "restaurarVenta",
  )(tx, v, u);
const crearVersion = (tx: Tx, e: unknown, f: unknown) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<unknown>>(
    "crearVersion",
  )(tx, e, f);

let admin: Pool;
let ec: EscenarioArchivos;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let ux: string;
let ux2: string;

beforeAll(async () => {
  admin = abrirAdmin(16);
  ec = new EscenarioArchivos(admin);
  X = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  ux2 = (await ec.miembro(X, "contador")).id;
  backend = crearDb("contapp_backend", 10);
  worker = crearDb("contapp_worker", 8);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((d) => d?.catch(() => undefined)),
  );
  await admin?.end();
});

interface Generado {
  nueva: boolean;
  version: number | null;
  /** Cuantas filas excluidas vio la lectura de esta generacion (ventas: exclusion vigente; compras: no se usa). */
  excluidasVistas: number;
  /** Version de la primera compra vigente que vio la lectura (compras). */
  versionCompraVista: number | null;
}

/**
 * La transaccion del worker (plan «Cola y worker»): advisory del libro -> fijar `generado` desde `abierto` -> leer filas -> numerar ->
 * insertar. Si el estado ya no era `abierto` (otra generacion lo cambio), devuelve la ultima version sin crear otra (D6).
 * `retener` mantiene la transaccion abierta despues de fijar el estado y leer, hasta que se suelte.
 */
async function generar(
  libro: Libro,
  c: ClientePrueba,
  trabajoId: string,
  retener?: () => Promise<void>,
): Promise<Generado> {
  return worker.withTenant({ tenantId: X }, async (tx) => {
    await bloquearPeriodoLibro(tx, c.id, PERIODO, libro);
    const fijar = libro === "ventas" ? fijarVentas : fijarCompras;
    const fijado = await fijar(tx, c.id, PERIODO, "abierto", "generado", ux);
    if (fijado === null) {
      const u = await ultimaVersion(tx, c.id, PERIODO, libro);
      return {
        nueva: false,
        version: u?.version ?? null,
        excluidasVistas: 0,
        versionCompraVista: null,
      };
    }
    let excluidasVistas = 0;
    let versionCompraVista: number | null = null;
    if (libro === "ventas") {
      const f = await leerFilasReemplazoVentas(tx, c.id, PERIODO);
      excluidasVistas = f.vigente.filter((v) => v.exclusion !== null).length;
    } else {
      const f = await leerFilasReemplazo(tx, c.id, PERIODO);
      versionCompraVista = f.vigente[0]?.version ?? null;
    }
    if (retener) await retener();
    const u = await ultimaVersion(tx, c.id, PERIODO, libro);
    const version = (u?.version ?? 0) + 1;
    const d = datosArchivo(X, c, ux, trabajoId, {
      libro,
      version,
      excluidas: excluidasVistas,
      ...(libro === "ventas"
        ? { impactoDg: null, impactoDgng: null, impactoDng: null }
        : {}),
    });
    await insertarVersion(tx, entradaVersion(d));
    return { nueva: true, version, excluidasVistas, versionCompraVista };
  });
}

/** `generar` retenida: `dentro` se cumple cuando ya fijo el estado y leyo las filas (o si fallo antes); `soltar` la deja terminar. */
function generarRetenida(libro: Libro, c: ClientePrueba, trabajoId: string) {
  let soltar!: () => void;
  const espera = new Promise<void>((r) => (soltar = r));
  let adentro!: () => void;
  const listo = new Promise<void>((r) => (adentro = r));
  const gen = generar(libro, c, trabajoId, async () => {
    adentro();
    await espera;
  });
  return {
    gen,
    dentro: Promise.race([
      listo,
      gen.then(
        () => undefined,
        () => undefined,
      ),
    ]),
    soltar,
  };
}

/** Venta del SIRE; deja la fila de `venta_periodo` creada (`abierto`) para que los bloqueos sean de fila y no de insercion. */
async function ventaSire(c: ClientePrueba, numero = "1") {
  await ec.periodoDe("ventas", X, c, PERIODO, "abierto");
  return ec.venta(X, c, { origen: "sire", serie: "B001", numero });
}
const datosExcluir = (
  c: ClientePrueba,
  ventaId: string,
  motivo = "Descuadrada",
) => ({ clienteId: c.id, periodo: PERIODO, ventaId, motivo, usuarioId: ux });
/** Escritura de ventas del backend: excluir. Devuelve 'ok' | 'periodo_generado' (o el codigo de error). */
const escribirExcluir = (
  c: ClientePrueba,
  v: string,
  llegar?: () => Promise<void>,
) =>
  codigoDeEscritura(
    backend.withTenant({ tenantId: X }, async (tx) => {
      if (llegar) await llegar();
      return escrituraVentas(tx, c.id, PERIODO, () =>
        excluirVenta(tx, datosExcluir(c, v)),
      );
    }),
  );
const escribirRestaurar = (
  c: ClientePrueba,
  v: string,
  llegar?: () => Promise<void>,
) =>
  codigoDeEscritura(
    backend.withTenant({ tenantId: X }, async (tx) => {
      if (llegar) await llegar();
      return escrituraVentas(tx, c.id, PERIODO, () =>
        restaurarVenta(tx, v, ux2),
      );
    }),
  );
async function codigoDeEscritura(
  p: Promise<unknown>,
): Promise<"ok" | "periodo_generado" | string> {
  try {
    const r = await p;
    return r === false || r === null ? "sin_efecto" : "ok";
  } catch (e) {
    return e instanceof PeriodoGenerado
      ? "periodo_generado"
      : await codigoRepo(Promise.reject(e));
  }
}
const SIN_INTERBLOQUEO = (codigos: string[]) => {
  for (const c of codigos) {
    expect(c, "interbloqueo o error de bloqueo").not.toBe("40P01");
    expect(c).not.toBe("55P03");
    expect(c).not.toBe("40001");
  }
};
const versionesDe = async (c: ClientePrueba, libro: Libro) =>
  (
    await admin.query(
      "select version, excluidas from archivo_generado where cliente_id = $1 and periodo = $2 and libro = $3 order by version",
      [c.id, PERIODO, libro],
    )
  ).rows as {
    version: number;
    excluidas: number;
  }[];
const vigentes = (v: string) =>
  contarEn(
    admin,
    "venta_exclusion",
    "venta_id = $1 and restaurada_en is null",
    [v],
  );

// =================================================================================================
describe("dos generaciones del mismo libro a la vez dejan una sola version (CA-7, D6)", () => {
  it.each<[Libro]>([["compras"], ["ventas"]])(
    "%s · 10 rondas: una crea la version 1 y la otra devuelve esa misma sin crear otra",
    async (libro) => {
      for (let ronda = 0; ronda < 10; ronda++) {
        const c = await ec.cliente(X);
        if (libro === "ventas") await ventaSire(c);
        else await ec.compra(X, c, { montos: MONTOS_DG });
        const t1 = await ec.trabajoArchivo(X, c);
        const t2 = await ec.trabajoArchivo(X, c);
        const llegar = barrera(2);
        // Las dos arrancan juntas (barrera ANTES de la transaccion): la segunda espera el advisory y despues ve el estado `generado`.
        const una = (t: string) =>
          (async () => {
            await llegar();
            return generar(libro, c, t);
          })().then(
            (r) => r,
            (e) => ({
              error: String(
                (e as { codigo?: string; code?: string }).codigo ??
                  (e as { code?: string }).code ??
                  "sin_codigo",
              ),
            }),
          );
        const r = await Promise.race([
          Promise.all([una(t1), una(t2)]),
          new Promise<never>((_, rechazo) =>
            setTimeout(
              () => rechazo(new Error("colgado: posible interbloqueo")),
              20000,
            ),
          ),
        ]);
        const errores = r
          .filter((x): x is { error: string } => "error" in x)
          .map((x) => x.error);
        SIN_INTERBLOQUEO(errores);
        expect(errores, `ronda ${ronda}`).toEqual([]);
        const hechos = r as Generado[];
        expect(
          hechos.filter((x) => x.nueva),
          `ronda ${ronda}: una sola crea`,
        ).toHaveLength(1);
        expect(
          hechos.filter((x) => !x.nueva).every((x) => x.version === 1),
          `ronda ${ronda}: la otra devuelve la version 1`,
        ).toBe(true);
        expect(await versionesDe(c, libro), `ronda ${ronda}`).toEqual([
          { version: 1, excluidas: 0 },
        ]);
      }
    },
    120_000,
  );

  it("compras y ventas del mismo cliente y periodo se generan a la vez sin esperarse ni interbloquearse (advisory y estado distintos)", async () => {
    const c = await ec.cliente(X);
    await ventaSire(c);
    await ec.compra(X, c, { montos: MONTOS_DG });
    const [a, b] = await Promise.all([
      generar("compras", c, await ec.trabajoArchivo(X, c)),
      generar("ventas", c, await ec.trabajoArchivo(X, c)),
    ]);
    expect([a.version, b.version]).toEqual([1, 1]);
    expect(await versionesDe(c, "compras")).toHaveLength(1);
    expect(await versionesDe(c, "ventas")).toHaveLength(1);
  });

  it("generar un cliente no retiene las escrituras de otro cliente del mismo estudio", async () => {
    const c = await ec.cliente(X);
    const otro = await ec.cliente(X);
    await ventaSire(c);
    const vOtro = await ventaSire(otro);
    const trabajo = await ec.trabajoArchivo(X, c);
    const retenida = generarRetenida("ventas", c, trabajo);
    const gen = retenida.gen;
    await retenida.dentro;
    expect(
      await conPlazo(escribirExcluir(otro, vOtro), 3000),
      "el otro cliente no espera",
    ).toBe("ok");
    retenida.soltar();
    expect((await gen).nueva).toBe(true);
  });
});

// =================================================================================================
describe("generar contra excluir y restaurar ventas (D5, D12, CA-10, CA-15, CA-16)", () => {
  it("orden A: una exclusion en curso (advisory + FOR SHARE, sin confirmar) retiene a generar; al confirmarse, la exclusion entra entera en el archivo", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c);
    const trabajo = await ec.trabajoArchivo(X, c);
    const escritura = sostener(backend, X, (tx) =>
      escrituraVentas(tx, c.id, PERIODO, () =>
        excluirVenta(tx, datosExcluir(c, v)),
      ),
    );
    await escritura.dentro;
    const gen = generar("ventas", c, trabajo);
    expect(
      await conPlazo(gen, 800),
      "generar espera a la escritura en curso",
    ).toBe("pendiente");
    escritura.soltar();
    await escritura.fin;
    const r = await gen;
    expect(r).toMatchObject({ nueva: true, version: 1, excluidasVistas: 1 });
    expect(await versionesDe(c, "ventas")).toEqual([
      { version: 1, excluidas: 1 },
    ]);
    expect(await vigentes(v)).toBe(1);
  });

  it("orden B: generar en curso (periodo generado, sin confirmar) retiene a la exclusion; al confirmarse, la exclusion se rechaza con periodo_generado y el archivo no la lleva", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c);
    const trabajo = await ec.trabajoArchivo(X, c);
    const retenida = generarRetenida("ventas", c, trabajo);
    const gen = retenida.gen;
    await retenida.dentro;
    const excluir = escribirExcluir(c, v);
    expect(await conPlazo(excluir, 800), "excluir espera a generar").toBe(
      "pendiente",
    );
    retenida.soltar();
    expect(await gen).toMatchObject({
      nueva: true,
      version: 1,
      excluidasVistas: 0,
    });
    expect(await excluir).toBe("periodo_generado");
    expect(await versionesDe(c, "ventas")).toEqual([
      { version: 1, excluidas: 0 },
    ]);
    expect(await vigentes(v)).toBe(0);
  });

  it("orden A con restaurar: la restauracion en curso entra entera (el archivo no lleva la exclusion) y orden B la rechaza (sigue excluida)", async () => {
    const a = await ec.cliente(X);
    const va = await ventaSire(a);
    await ec.exclusion(X, a.id, va, { por: ux });
    const ta = await ec.trabajoArchivo(X, a);
    const restaurando = sostener(backend, X, (tx) =>
      escrituraVentas(tx, a.id, PERIODO, () => restaurarVenta(tx, va, ux2)),
    );
    await restaurando.dentro;
    const genA = generar("ventas", a, ta);
    expect(await conPlazo(genA, 800)).toBe("pendiente");
    restaurando.soltar();
    await restaurando.fin;
    expect(await genA).toMatchObject({ nueva: true, excluidasVistas: 0 });
    expect(await versionesDe(a, "ventas")).toEqual([
      { version: 1, excluidas: 0 },
    ]);
    expect(await vigentes(va)).toBe(0);

    const b = await ec.cliente(X);
    const vb = await ventaSire(b);
    await ec.exclusion(X, b.id, vb, { por: ux });
    const tb = await ec.trabajoArchivo(X, b);
    const retenidaB = generarRetenida("ventas", b, tb);
    const genB = retenidaB.gen;
    await retenidaB.dentro;
    const restaurar = escribirRestaurar(b, vb);
    expect(await conPlazo(restaurar, 800)).toBe("pendiente");
    retenidaB.soltar();
    expect(await genB).toMatchObject({ nueva: true, excluidasVistas: 1 });
    expect(await restaurar).toBe("periodo_generado");
    expect(await versionesDe(b, "ventas")).toEqual([
      { version: 1, excluidas: 1 },
    ]);
    expect(await vigentes(vb)).toBe(1);
  });

  it("10 rondas en carrera: excluir y generar; si la exclusion entra, el archivo la lleva (excluidas = 1); si no, 409 y el archivo no la lleva", async () => {
    let entraron = 0;
    let rechazadas = 0;
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const v = await ventaSire(c);
      const trabajo = await ec.trabajoArchivo(X, c);
      const llegar = barrera(2);
      const [gen, exc] = await Promise.all([
        (async () => {
          await llegar();
          return generar("ventas", c, trabajo);
        })().catch((e) => ({
          error: String((e as { code?: string }).code ?? "sin_codigo"),
        })),
        escribirExcluir(c, v, llegar),
      ]);
      SIN_INTERBLOQUEO([exc, "error" in gen ? gen.error : "ok"]);
      expect("error" in gen ? gen.error : "ok", `ronda ${ronda}: generar`).toBe(
        "ok",
      );
      const versiones = await versionesDe(c, "ventas");
      expect(versiones, `ronda ${ronda}`).toHaveLength(1);
      if (exc === "ok") {
        entraron++;
        expect(
          versiones[0].excluidas,
          `ronda ${ronda}: entro antes, el archivo la lleva`,
        ).toBe(1);
        expect(await vigentes(v)).toBe(1);
      } else {
        rechazadas++;
        expect(exc, `ronda ${ronda}`).toBe("periodo_generado");
        expect(
          versiones[0].excluidas,
          `ronda ${ronda}: entro despues, el archivo no la lleva`,
        ).toBe(0);
        expect(await vigentes(v)).toBe(0);
      }
    }
    expect(entraron + rechazadas).toBe(10);
  }, 120_000);

  it("10 rondas en carrera: restaurar y generar; si la restauracion entra, el archivo no lleva la exclusion; si no, 409 y la lleva", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const v = await ventaSire(c);
      await ec.exclusion(X, c.id, v, { por: ux });
      const trabajo = await ec.trabajoArchivo(X, c);
      const llegar = barrera(2);
      const [gen, res] = await Promise.all([
        (async () => {
          await llegar();
          return generar("ventas", c, trabajo);
        })().catch((e) => ({
          error: String((e as { code?: string }).code ?? "sin_codigo"),
        })),
        escribirRestaurar(c, v, llegar),
      ]);
      SIN_INTERBLOQUEO([res, "error" in gen ? gen.error : "ok"]);
      expect("error" in gen ? gen.error : "ok", `ronda ${ronda}: generar`).toBe(
        "ok",
      );
      const versiones = await versionesDe(c, "ventas");
      expect(versiones, `ronda ${ronda}`).toHaveLength(1);
      if (res === "ok") {
        expect(versiones[0].excluidas, `ronda ${ronda}: restaurada antes`).toBe(
          0,
        );
        expect(await vigentes(v)).toBe(0);
      } else {
        expect(res, `ronda ${ronda}`).toBe("periodo_generado");
        expect(
          versiones[0].excluidas,
          `ronda ${ronda}: restaurada despues: rechazada`,
        ).toBe(1);
        expect(await vigentes(v)).toBe(1);
      }
    }
  }, 120_000);

  it("dos exclusiones simultaneas de la misma venta mientras se genera dejan a lo sumo una vigente y ninguna despues de generar", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const c = await ec.cliente(X);
      const v = await ventaSire(c);
      const trabajo = await ec.trabajoArchivo(X, c);
      const llegar = barrera(3);
      const [gen, e1, e2] = await Promise.all([
        (async () => {
          await llegar();
          return generar("ventas", c, trabajo);
        })(),
        escribirExcluir(c, v, llegar),
        escribirExcluir(c, v, llegar),
      ]);
      SIN_INTERBLOQUEO([e1, e2]);
      expect(gen.nueva).toBe(true);
      expect(await vigentes(v), `ronda ${ronda}`).toBeLessThanOrEqual(1);
      const versiones = await versionesDe(c, "ventas");
      expect(
        versiones[0].excluidas,
        `ronda ${ronda}: coincide con lo vigente`,
      ).toBe(await vigentes(v));
    }
  }, 120_000);
});

// =================================================================================================
describe("generar contra una accion de compras (014: FOR SHARE sin advisory), en ambos ordenes (CA-6, CA-7)", () => {
  /** La accion de compras del backend: `compra_periodo FOR SHARE` -> con `generado`, rechaza -> nueva version de la compra. */
  const accion = (
    c: ClientePrueba,
    compraId: string,
    llegar?: () => Promise<void>,
  ) =>
    codigoDeEscritura(
      backend.withTenant({ tenantId: X }, async (tx) => {
        if (llegar) await llegar();
        const e = await leerEstadoPeriodo(tx, c.id, PERIODO);
        if (e.estado === "generado") throw new PeriodoGenerado();
        return crearVersion(
          tx,
          {
            compraId,
            versionBase: 1,
            datos: {
              montos: montos({ biDg: "900.00", igvDg: "162.00" }),
              excluida: false,
              motivo: null,
              clasificada: true,
            },
            accion: "editar",
            usuarioId: ux,
          },
          { evaluar: () => [] },
        );
      }),
    );
  const versionVigente = async (compraId: string) =>
    (
      await admin.query("select version_vigente from compra where id = $1", [
        compraId,
      ])
    ).rows[0].version_vigente as number;

  it("orden A: una accion en curso (FOR SHARE, sin confirmar) retiene a generar; el archivo lleva la version nueva de la compra", async () => {
    const c = await ec.cliente(X);
    const compra = await ec.compra(X, c, { montos: MONTOS_DG });
    await ec.periodoDe("compras", X, c, PERIODO, "abierto");
    const trabajo = await ec.trabajoArchivo(X, c);
    const sostenida = sostener(backend, X, async (tx) => {
      const e = await leerEstadoPeriodo(tx, c.id, PERIODO);
      expect(e.estado).toBe("abierto");
      return crearVersion(
        tx,
        {
          compraId: compra.id,
          versionBase: 1,
          datos: {
            montos: montos({ biDg: "900.00", igvDg: "162.00" }),
            excluida: false,
            motivo: null,
            clasificada: true,
          },
          accion: "editar",
          usuarioId: ux,
        },
        { evaluar: () => [] },
      );
    });
    await sostenida.dentro;
    const gen = generar("compras", c, trabajo);
    expect(await conPlazo(gen, 800), "generar espera a la accion").toBe(
      "pendiente",
    );
    sostenida.soltar();
    await sostenida.fin;
    expect(await gen).toMatchObject({
      nueva: true,
      version: 1,
      versionCompraVista: 2,
    });
    expect(await versionVigente(compra.id)).toBe(2);
  });

  it("orden B: generar en curso retiene a la accion; al confirmarse la accion recibe periodo_generado y la compra queda en su version 1", async () => {
    const c = await ec.cliente(X);
    const compra = await ec.compra(X, c, { montos: MONTOS_DG });
    await ec.periodoDe("compras", X, c, PERIODO, "abierto");
    const trabajo = await ec.trabajoArchivo(X, c);
    const retenida = generarRetenida("compras", c, trabajo);
    const gen = retenida.gen;
    await retenida.dentro;
    const a = accion(c, compra.id);
    expect(await conPlazo(a, 800), "la accion espera a generar").toBe(
      "pendiente",
    );
    retenida.soltar();
    expect(await gen).toMatchObject({
      nueva: true,
      version: 1,
      versionCompraVista: 1,
    });
    expect(await a).toBe("periodo_generado");
    expect(await versionVigente(compra.id)).toBe(1);
  });

  it("10 rondas en carrera: accion y generar; si la accion entra, el archivo lleva la version 2; si no, 409 y el archivo lleva la 1; sin interbloqueos", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const compra = await ec.compra(X, c, { montos: MONTOS_DG });
      await ec.periodoDe("compras", X, c, PERIODO, "abierto");
      const trabajo = await ec.trabajoArchivo(X, c);
      const llegar = barrera(2);
      const [gen, acc] = await Promise.all([
        (async () => {
          await llegar();
          return generar("compras", c, trabajo);
        })().catch((e) => ({
          error: String((e as { code?: string }).code ?? "sin_codigo"),
        })),
        accion(c, compra.id, llegar),
      ]);
      SIN_INTERBLOQUEO([acc, "error" in gen ? gen.error : "ok"]);
      expect("error" in gen ? gen.error : "ok", `ronda ${ronda}: generar`).toBe(
        "ok",
      );
      const g = gen as Generado;
      expect(await versionesDe(c, "compras"), `ronda ${ronda}`).toHaveLength(1);
      if (acc === "ok") {
        expect(
          g.versionCompraVista,
          `ronda ${ronda}: la accion entro antes`,
        ).toBe(2);
        expect(await versionVigente(compra.id)).toBe(2);
      } else {
        expect(acc, `ronda ${ronda}`).toBe("periodo_generado");
        expect(
          g.versionCompraVista,
          `ronda ${ronda}: la accion entro despues`,
        ).toBe(1);
        expect(await versionVigente(compra.id)).toBe(1);
      }
    }
  }, 120_000);
});

// =================================================================================================
describe("reabrir y generar de nuevo (CA-6, CA-14) con el estado del libro", () => {
  it.each<[Libro]>([["compras"], ["ventas"]])(
    "%s · generado -> reabrir (backend) -> generar crea la version 2; las dos siguen legibles",
    async (libro) => {
      const c = await ec.cliente(X);
      if (libro === "ventas") await ventaSire(c);
      else await ec.compra(X, c, { montos: MONTOS_DG });
      const fijar = libro === "ventas" ? fijarVentas : fijarCompras;
      expect(
        (await generar(libro, c, await ec.trabajoArchivo(X, c))).version,
      ).toBe(1);
      await backend.withTenant({ tenantId: X }, (tx) =>
        fijar(tx, c.id, PERIODO, "generado", "abierto", ux2),
      );
      expect(
        (await generar(libro, c, await ec.trabajoArchivo(X, c))).version,
      ).toBe(2);
      expect((await versionesDe(c, libro)).map((v) => v.version)).toEqual([
        1, 2,
      ]);
    },
  );
});
