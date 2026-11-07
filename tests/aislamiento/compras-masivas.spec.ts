// Spec 014 (T6, rojo): acciones masivas y orden de bloqueo contra la BD real (CA-3, CA-18; D-2, D-15, DU-5, DU-14, plan «Contrato
// real de 013» punto 8). `transformar` y `evaluar` son funciones de prueba (compras-soporte.ts): `packages/db` no importa el dominio.
//
// FIRMAS que fija (T12):
//   aplicarMasiva(tx, { clienteId, periodo, usuarioId, accion: string, parametros: unknown,
//       items: { compraId: string; versionBase: number }[] }, { transformar, evaluar }):
//       Promise<{ operacionId: string | null; aplicadas: number; rechazadas: { compraId: string; codigo: string }[] }>
//       Parcial (DU-5): bloquea las filas en orden de id (sea cual sea el orden de `items`), y a cada una le aplica lo mismo que
//       aplicarAccion; las que no se pueden quedan en `rechazadas` con su codigo (version_obsoleta, fila_excluida, no_encontrada o
//       el `rechazo` que devuelva transformar: requiere_dato, revisar_de_nuevo, no_masiva) y NO escriben. Las validas forman UNA
//       compra_operacion (tipo = accion) y todas sus versiones llevan ese operacion_id. Sin ninguna aplicada: operacionId null y
//       ninguna operacion creada. Una compra de otro estudio, cliente o periodo, inexistente o descartada es `no_encontrada`.
//       Si transformar o evaluar lanzan, la llamada falla entera y no queda nada escrito.
//       Pasa a `caducada` las operaciones `deshecha` del usuario en ese cliente y periodo, como aplicarAccion.
//   leerEstadoPeriodo(tx, clienteId, periodo, opciones?: { compartido?: boolean }): Promise<EstadoPeriodo>
//       EstadoPeriodo = { estado: 'abierto' | 'revisado' | 'generado'; marcadoPor: string | null; marcadoEn: Date | null }.
//       Sin fila equivale a abierto; con `compartido: true` crea la fila si falta (INSERT ... ON CONFLICT DO NOTHING) y la lee con
//       FOR SHARE (primer bloqueo de las acciones tras el advisory de la descarga).
//   fijarEstadoPeriodo(tx, clienteId, periodo, desde, hacia, usuarioId): Promise<EstadoPeriodo | null>
//       Compare-and-set bajo FOR UPDATE; null si el estado vigente no era `desde`. La ausencia de fila equivale a abierto.
//   Orden de bloqueo unico: advisory (cliente, periodo, 'compras') -> compra_periodo -> compra_operacion -> compra por id ascendente.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { Tx } from "./soporte";
import type { ContappDb } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  barrera,
  claveCompra,
  codigoDe,
  contarFilas,
  EscenarioCompras,
  evaluadorFalso,
  MONTOS_DG,
  PERIODO,
  sinHallazgos,
  transformarFalso,
  type CompraLeida,
  type Evaluar,
  type IdentidadCompra,
  type Montos,
  type ParametrosFalsos,
  type Transformar,
} from "./compras-soporte";
import { montos } from "./compras-soporte";

interface Entrada {
  clienteId: string;
  periodo: string;
  usuarioId: string;
  accion: string;
  parametros: ParametrosFalsos;
  items: { compraId: string; versionBase: number }[];
}
interface Resultado {
  operacionId: string | null;
  aplicadas: number;
  rechazadas: { compraId: string; codigo: string }[];
}
const aplicarMasiva = (
  tx: Tx,
  e: Entrada,
  f: { transformar: Transformar; evaluar: Evaluar },
) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<Resultado>>(
    "aplicarMasiva",
  )(tx, e, f);
const aplicarAccion = (
  tx: Tx,
  e: unknown,
  f: { transformar: Transformar; evaluar: Evaluar },
) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<unknown>>(
    "aplicarAccion",
  )(tx, e, f);
const insertarCompras = (
  tx: Tx,
  c: unknown,
  n: unknown,
  f: { evaluar: Evaluar },
) =>
  exportado<(tx: Tx, c: unknown, n: unknown, f: unknown) => Promise<string[]>>(
    "insertarCompras",
  )(tx, c, n, f);
const bloquearPeriodoLibro = (tx: Tx, c: string, p: string, libro: string) =>
  exportado<(tx: Tx, c: string, p: string, l: string) => Promise<void>>(
    "bloquearPeriodoLibro",
  )(tx, c, p, libro);
const leerEstadoPeriodo = (
  tx: Tx,
  c: string,
  p: string,
  o?: { compartido?: boolean },
) =>
  exportado<
    (tx: Tx, c: string, p: string, o?: unknown) => Promise<{ estado: string }>
  >("leerEstadoPeriodo")(tx, c, p, o);
const fijarEstadoPeriodo = (
  tx: Tx,
  c: string,
  p: string,
  desde: string,
  hacia: string,
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
    ) => Promise<{ estado: string } | null>
  >("fijarEstadoPeriodo")(tx, c, p, desde, hacia, u);

let admin: Pool;
let ec: EscenarioCompras;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let ux2: string;
let propX: string;

beforeAll(async () => {
  admin = abrirAdmin(10);
  ec = new EscenarioCompras(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  ux2 = (await ec.miembro(X, "contador")).id;
  backend = crearDb("contapp_backend", 16);
  worker = crearDb("contapp_worker", 4);
  propX = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

const comoBackend = <T>(fn: (tx: Tx) => Promise<T>) =>
  backend.withTenant({ tenantId: X }, fn);
const versionesDe = async (id: string) =>
  (
    await admin.query(
      "select * from compra_version where compra_id = $1 order by n",
      [id],
    )
  ).rows;
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const items = (cs: { id: string }[], base = 1) =>
  cs.map((c) => ({ compraId: c.id, versionBase: base }));
const masiva = (
  c: ClientePrueba,
  accion: string,
  parametros: ParametrosFalsos,
  its: Entrada["items"],
  f?: { transformar?: Transformar; evaluar?: Evaluar },
  usuarioId = ux,
) =>
  comoBackend((tx) =>
    aplicarMasiva(
      tx,
      {
        clienteId: c.id,
        periodo: PERIODO,
        usuarioId,
        accion,
        parametros,
        items: its,
      },
      {
        transformar: f?.transformar ?? transformarFalso,
        evaluar: f?.evaluar ?? sinHallazgos().evaluar,
      },
    ),
  );
async function sembrar(
  c: ClientePrueba,
  n: number,
  prefijo: string,
): Promise<{ id: string; clave: string }[]> {
  const r: { id: string; clave: string }[] = [];
  for (let i = 1; i <= n; i++)
    r.push(
      await ec.compra(X, c, {
        serie: prefijo,
        numero: String(i),
        propuestaId: propX,
      }),
    );
  return r;
}

// =================================================================================================
describe("aplicarMasiva · parcial, una sola operacion, informe de rechazadas (D-15, DU-5, CA-18)", () => {
  it("12 filas con 2 obsoletas, 1 excluida y 1 no masiva: se aplican 8 en una sola operacion y el informe lista las 4 rechazadas", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 12, "FM01");
    const [o1, o2, ex, nm] = [filas[0], filas[1], filas[2], filas[3]];
    await ec.version(X, o1.id, 2);
    await ec.version(X, o2.id, 2);
    await ec.version(X, ex.id, 2, {
      excluida: true,
      motivo: "zapatillas",
      accion: "excluir",
    });
    const transformar: Transformar = (actual, p) =>
      actual.clave === nm.clave
        ? { rechazo: "no_masiva" }
        : transformarFalso(actual, p);
    const e = evaluadorFalso();
    const ops = await contarFilas(admin, "compra_operacion", "tenant_id = $1", [
      X,
    ]);
    const its = [
      ...items(filas.slice(0, 2), 1),
      { compraId: ex.id, versionBase: 2 },
      ...items(filas.slice(3), 1),
    ];
    const r = await masiva(c, "clasificar", { tipo: "dng" }, its, {
      transformar,
      evaluar: e.evaluar,
    });
    expect(r.aplicadas).toBe(8);
    expect(r.operacionId).toEqual(expect.any(String));
    expect(
      [...r.rechazadas].sort((a, b) => a.compraId.localeCompare(b.compraId)),
    ).toEqual(
      [
        { compraId: o1.id, codigo: "version_obsoleta" },
        { compraId: o2.id, codigo: "version_obsoleta" },
        { compraId: ex.id, codigo: "fila_excluida" },
        { compraId: nm.id, codigo: "no_masiva" },
      ].sort((a, b) => a.compraId.localeCompare(b.compraId)),
    );
    expect(
      await contarFilas(admin, "compra_operacion", "tenant_id = $1", [X]),
      "una sola operacion para toda la masiva",
    ).toBe(ops + 1);
    expect(
      (
        await admin.query(
          "select tipo, estado, usuario_id from compra_operacion where id = $1",
          [r.operacionId],
        )
      ).rows[0],
    ).toEqual({ tipo: "clasificar", estado: "vigente", usuario_id: ux });
    const aplicadas = filas.slice(4);
    for (const f of aplicadas) {
      const v = await versionesDe(f.id);
      expect(
        v.map((x) => x.n),
        f.clave,
      ).toEqual([1, 2]);
      expect(v[1]).toMatchObject({
        operacion_id: r.operacionId,
        accion: "clasificar",
        bi_dng: "1000.00",
        bi_dg: "0.00",
        total: "1180.00",
      });
    }
    for (const f of [o1, o2, ex, nm])
      expect(
        (await versionesDe(f.id)).every((x) => x.operacion_id === null),
        f.clave,
      ).toBe(true);
    expect((await versionesDe(nm.id)).map((x) => x.n)).toEqual([1]);
    expect(e.llamadas).toHaveLength(8);
  });

  it("sin ninguna aplicada: operacionId null, 0 aplicadas, el informe lista todas y no se crea operacion ni version", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 3, "FM02");
    for (const f of filas) await ec.version(X, f.id, 2);
    const ops = await contarFilas(admin, "compra_operacion", "tenant_id = $1", [
      X,
    ]);
    const r = await masiva(c, "clasificar", { tipo: "dng" }, items(filas, 1));
    expect(r).toMatchObject({ operacionId: null, aplicadas: 0 });
    expect(r.rechazadas.map((x) => x.codigo)).toEqual([
      "version_obsoleta",
      "version_obsoleta",
      "version_obsoleta",
    ]);
    expect(
      await contarFilas(admin, "compra_operacion", "tenant_id = $1", [X]),
    ).toBe(ops);
    expect(
      await contarFilas(
        admin,
        "compra_version",
        "compra_id = any($1::uuid[])",
        [ids(filas)],
      ),
    ).toBe(6);
  });

  it("un id de otro estudio sale no_encontrada igual que uno inexistente, que uno de otro cliente o periodo y que una descartada (sin revelar)", async () => {
    const c = await ec.cliente(X);
    const propias = await sembrar(c, 2, "FM03");
    const ajena = await ec.compra(Y, cy);
    const otroCliente = await ec.compra(X, cx, { propuestaId: propX });
    const otroPeriodo = await ec.compra(X, c, { periodo: "202609" });
    const descartada = await ec.compra(X, c, { origen: "agregada" });
    await admin.query("update compra set descartada_en = now() where id = $1", [
      descartada.id,
    ]);
    const fantasma = "00000000-0000-4000-8000-0000000000aa";
    const r = await masiva(c, "clasificar", { tipo: "dng" }, [
      ...items(propias),
      ...items([ajena, otroCliente, otroPeriodo, descartada]),
      { compraId: fantasma, versionBase: 1 },
    ]);
    expect(r.aplicadas).toBe(2);
    expect(r.rechazadas).toHaveLength(5);
    expect(r.rechazadas.every((x) => x.codigo === "no_encontrada")).toBe(true);
    expect(r.rechazadas.map((x) => x.compraId).sort()).toEqual(
      [
        ajena.id,
        otroCliente.id,
        otroPeriodo.id,
        descartada.id,
        fantasma,
      ].sort(),
    );
    for (const f of [ajena, otroCliente, otroPeriodo])
      expect(await versionesDe(f.id), f.id).toHaveLength(1);
  });

  it("restaurar en masa devuelve las excluidas; excluir en masa lleva el motivo; el rechazo de transformar (requiere_dato) se informa por fila", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 3, "FM04");
    const ex = await masiva(
      c,
      "excluir",
      { tipo: "excluir", motivo: "uso personal" },
      items(filas),
    );
    expect(ex.aplicadas).toBe(3);
    for (const f of filas)
      expect((await versionesDe(f.id))[1]).toMatchObject({
        excluida: true,
        motivo: "uso personal",
        operacion_id: ex.operacionId,
      });
    const re = await masiva(
      c,
      "restaurar",
      { tipo: "restaurar" },
      items(filas, 2),
    );
    expect(re.aplicadas).toBe(3);
    for (const f of filas)
      expect((await versionesDe(f.id))[2]).toMatchObject({
        excluida: false,
        motivo: null,
        accion: "restaurar",
      });
    const sin = await masiva(
      c,
      "sugerencia",
      { tipo: "rechazar", codigo: "requiere_dato" },
      items(filas, 3),
    );
    expect(sin).toMatchObject({ operacionId: null, aplicadas: 0 });
    expect(sin.rechazadas.map((x) => x.codigo)).toEqual([
      "requiere_dato",
      "requiere_dato",
      "requiere_dato",
    ]);
  });

  it("si transformar lanza en una fila, la llamada falla entera y no queda version ni operacion", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 6, "FM05");
    const ops = await contarFilas(admin, "compra_operacion", "tenant_id = $1", [
      X,
    ]);
    const quinta = [...filas].sort((a, b) => a.id.localeCompare(b.id))[4];
    const transformar: Transformar = (actual, p) => {
      if (actual.id === quinta.id) throw new Error("fallo a proposito");
      return transformarFalso(actual, p);
    };
    const codigo = await codigoDe(
      masiva(c, "clasificar", { tipo: "dng" }, items(filas), { transformar }),
    );
    expect(codigo).not.toBe("ok");
    expect(
      await contarFilas(
        admin,
        "compra_version",
        "compra_id = any($1::uuid[])",
        [ids(filas)],
      ),
    ).toBe(6);
    expect(
      await contarFilas(admin, "compra_operacion", "tenant_id = $1", [X]),
    ).toBe(ops);
    expect(
      await contarFilas(
        admin,
        "compra",
        "id = any($1::uuid[]) and version_vigente <> 1",
        [ids(filas)],
      ),
    ).toBe(0);
  });

  it("si evaluar lanza en la ultima fila, ninguna de las anteriores queda a medias", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 5, "FM06");
    let n = 0;
    const evaluar: Evaluar = () => {
      if (++n === 5) throw new Error("la regla fallo");
      return [];
    };
    expect(
      await codigoDe(
        masiva(c, "clasificar", { tipo: "dng" }, items(filas), { evaluar }),
      ),
    ).not.toBe("ok");
    expect(
      await contarFilas(
        admin,
        "compra_version",
        "compra_id = any($1::uuid[])",
        [ids(filas)],
      ),
    ).toBe(5);
    expect(
      await contarFilas(
        admin,
        "compra",
        "id = any($1::uuid[]) and version_vigente <> 1",
        [ids(filas)],
      ),
    ).toBe(0);
  });

  it("la masiva pasa a caducada las operaciones deshecha del propio usuario en ese periodo, y no las de otro usuario", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 2, "FM07");
    const propia = await ec.operacion(X, c, {
      usuarioId: ux,
      estado: "deshecha",
    });
    const ajena = await ec.operacion(X, c, {
      usuarioId: ux2,
      estado: "deshecha",
    });
    await masiva(c, "clasificar", { tipo: "dng" }, items(filas));
    const estado = async (id: string) =>
      (
        await admin.query("select estado from compra_operacion where id = $1", [
          id,
        ])
      ).rows[0].estado;
    expect(await estado(propia)).toBe("caducada");
    expect(await estado(ajena)).toBe("deshecha");
  });

  it("los montos de la masiva viajan como cadenas exactas: ninguna fila pierde centimos (0.10 + 0.20 sin deriva)", async () => {
    const c = await ec.cliente(X);
    const f = await ec.compra(X, c, {
      propuestaId: propX,
      montos: { biDg: "0.10", igvDg: "0.02" },
    });
    const g = await ec.compra(X, c, {
      propuestaId: propX,
      montos: { biDg: "0.20", igvDg: "0.04" },
    });
    await masiva(c, "clasificar", { tipo: "dng" }, items([f, g]));
    expect((await versionesDe(f.id))[1]).toMatchObject({
      bi_dng: "0.10",
      igv_dng: "0.02",
      total: "0.12",
    });
    expect((await versionesDe(g.id))[1]).toMatchObject({
      bi_dng: "0.20",
      igv_dng: "0.04",
      total: "0.24",
    });
  });
});

// =================================================================================================
describe("concurrencia de masivas: sin interbloqueos ni filas a medias (D-2, CA-3, plan punto 8)", () => {
  it("15 rondas: dos masivas con las mismas 30 filas en orden opuesto terminan sin 40P01; cada fila recibe exactamente una version nueva", async () => {
    for (let ronda = 0; ronda < 15; ronda++) {
      const c = await ec.cliente(X);
      const filas = await sembrar(c, 30, "FC01");
      const asc = items([...filas].sort((a, b) => a.id.localeCompare(b.id)));
      const desc = [...asc].reverse();
      const llegar = barrera(2);
      const lanzar = (its: Entrada["items"], u: string) =>
        comoBackend(async (tx) => {
          await llegar();
          return aplicarMasiva(
            tx,
            {
              clienteId: c.id,
              periodo: PERIODO,
              usuarioId: u,
              accion: "clasificar",
              parametros: { tipo: "dng" },
              items: its,
            },
            { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
          );
        });
      const r = await Promise.allSettled([lanzar(asc, ux), lanzar(desc, ux2)]);
      expect(
        r.map((x) =>
          x.status === "rejected"
            ? String(
                (x.reason as { code?: string; codigo?: string }).code ??
                  (x.reason as { codigo?: string }).codigo,
              )
            : "ok",
        ),
        `ronda ${ronda}`,
      ).toEqual(["ok", "ok"]);
      const [a, b] = r.map(
        (x) => (x as PromiseFulfilledResult<Resultado>).value,
      );
      expect(
        a.aplicadas + b.aplicadas,
        `ronda ${ronda}: cada fila la gana una sola`,
      ).toBe(30);
      const rechazadasOtra = [...a.rechazadas, ...b.rechazadas];
      expect(rechazadasOtra.every((x) => x.codigo === "version_obsoleta")).toBe(
        true,
      );
      expect(rechazadasOtra).toHaveLength(30);
      for (const f of filas) {
        const v = await versionesDe(f.id);
        expect(
          v.map((x) => x.n),
          `ronda ${ronda}: ${f.clave}`,
        ).toEqual([1, 2]);
      }
    }
  }, 120_000);

  it("una masiva y una accion de fila simultaneas sobre las mismas filas no interbloquean y no duplican versiones", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const filas = await sembrar(c, 12, "FC02");
      const llegar = barrera(2);
      const uno = filas[5];
      const m = comoBackend(async (tx) => {
        await llegar();
        return aplicarMasiva(
          tx,
          {
            clienteId: c.id,
            periodo: PERIODO,
            usuarioId: ux,
            accion: "clasificar",
            parametros: { tipo: "dng" },
            items: items(filas),
          },
          { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
        );
      });
      const a = comoBackend(async (tx) => {
        await llegar();
        return aplicarAccion(
          tx,
          {
            compraId: uno.id,
            versionBase: 1,
            accion: "editar",
            parametros: { tipo: "bi", valor: "5.00" },
            usuarioId: ux2,
          },
          { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
        );
      });
      const r = await Promise.allSettled([m, a]);
      const estados = r.map((x) =>
        x.status === "rejected"
          ? String(
              (x.reason as { codigo?: string; code?: string }).codigo ??
                (x.reason as { code?: string }).code,
            )
          : "ok",
      );
      expect(
        estados.filter((e) => e === "40P01"),
        `ronda ${ronda}`,
      ).toEqual([]);
      expect(
        estados.every((e) => e === "ok" || e === "version_obsoleta"),
        `ronda ${ronda}: ${estados.join(",")}`,
      ).toBe(true);
      for (const f of filas)
        expect(
          (await versionesDe(f.id)).map((x) => x.n),
          `ronda ${ronda}`,
        ).toEqual([1, 2]);
    }
  }, 120_000);

  it("10 rondas: una descarga (advisory, estado compartido, insertar), dos masivas y un cambio de estado a la vez terminan sin 40P01 (orden advisory -> periodo -> operacion -> compra)", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const filas = await sembrar(c, 20, "FC03");
      const propuestaId = await ec.propuesta(X, c, {
        libro: "compras",
        nuevas: 10,
      });
      const nuevas = Array.from({ length: 10 }, (_, i) => ({
        clave: claveCompra("01", "FC3N", String(i + 1), "6", "20100070970"),
        tipoDoc: "01",
        serie: "FC3N",
        numero: String(i + 1),
        docTipo: "6",
        docNumero: "20100070970",
        razonSocial: "PROVEEDOR SINTETICO SAC",
        fecha: "2026-10-05",
        moneda: "PEN",
        tipoCambio: null,
        montos: montos(MONTOS_DG),
      }));
      const asc = items([...filas].sort((a, b) => a.id.localeCompare(b.id)));
      const llegar = barrera(4);
      const descarga = worker.withTenant({ tenantId: X }, async (tx) => {
        await llegar();
        await bloquearPeriodoLibro(tx, c.id, PERIODO, "compras");
        await leerEstadoPeriodo(tx, c.id, PERIODO, { compartido: true });
        return insertarCompras(
          tx,
          { clienteId: c.id, periodo: PERIODO, propuestaId },
          nuevas,
          { evaluar: sinHallazgos().evaluar },
        );
      });
      const accion = (its: Entrada["items"], u: string) =>
        comoBackend(async (tx) => {
          await llegar();
          await leerEstadoPeriodo(tx, c.id, PERIODO, { compartido: true });
          return aplicarMasiva(
            tx,
            {
              clienteId: c.id,
              periodo: PERIODO,
              usuarioId: u,
              accion: "clasificar",
              parametros: { tipo: "dng" },
              items: its,
            },
            { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
          );
        });
      const estado = comoBackend(async (tx) => {
        await llegar();
        return fijarEstadoPeriodo(tx, c.id, PERIODO, "abierto", "revisado", ux);
      });
      const r = await Promise.allSettled([
        descarga,
        accion(asc, ux),
        accion([...asc].reverse(), ux2),
        estado,
      ]);
      const malos = r
        .filter((x): x is PromiseRejectedResult => x.status === "rejected")
        .map((x) =>
          String(
            (x.reason as { code?: string; codigo?: string }).code ??
              (x.reason as { codigo?: string }).codigo,
          ),
        );
      expect(malos, `ronda ${ronda}`).toEqual([]);
      expect(
        await contarFilas(
          admin,
          "compra",
          "cliente_id = $1 and propuesta_id = $2",
          [c.id, propuestaId],
        ),
        `ronda ${ronda}: la descarga entera`,
      ).toBe(10);
    }
  }, 120_000);
});

// =================================================================================================
describe("aplicarMasiva · alcance y limites", () => {
  it("acepta un lote grande en una sola operacion (500 filas) y todas las versiones llevan el mismo operacion_id", async () => {
    const c = await ec.cliente(X);
    const propuestaId = await ec.propuesta(X, c, {
      libro: "compras",
      nuevas: 500,
    });
    const nuevas: (IdentidadCompra & { montos: Montos })[] = Array.from(
      { length: 500 },
      (_, i) => ({
        clave: claveCompra("01", "FM08", String(i + 1), "6", "20100070970"),
        tipoDoc: "01",
        serie: "FM08",
        numero: String(i + 1),
        docTipo: "6",
        docNumero: "20100070970",
        razonSocial: null,
        fecha: "2026-10-05",
        moneda: "PEN",
        tipoCambio: null,
        montos: montos(MONTOS_DG),
      }),
    );
    const idsNuevos = await comoBackend((tx) =>
      insertarCompras(
        tx,
        { clienteId: c.id, periodo: PERIODO, propuestaId },
        nuevas,
        sinHallazgos(),
      ),
    );
    const r = await masiva(
      c,
      "clasificar",
      { tipo: "dng" },
      idsNuevos.map((id) => ({ compraId: id, versionBase: 1 })),
    );
    expect(r.aplicadas).toBe(500);
    expect(
      await contarFilas(admin, "compra_version", "operacion_id = $1", [
        r.operacionId,
      ]),
    ).toBe(500);
  }, 60_000);

  it("el compare-and-set de cada fila es independiente: una fila obsoleta no impide las demas", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 3, "FM09");
    await ec.version(X, filas[1].id, 2);
    const r = await masiva(c, "clasificar", { tipo: "dng" }, items(filas));
    expect(r.aplicadas).toBe(2);
    expect(r.rechazadas).toEqual([
      { compraId: filas[1].id, codigo: "version_obsoleta" },
    ]);
    expect((await versionesDe(filas[0].id)).map((v) => v.n)).toEqual([1, 2]);
    expect((await versionesDe(filas[2].id)).map((v) => v.n)).toEqual([1, 2]);
  });

  it("transformar recibe cada compra con la version que se esta reemplazando (no una leida antes de bloquear)", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 3, "FM10");
    const vistas: CompraLeida[] = [];
    const transformar: Transformar = (actual, p) => {
      vistas.push(actual);
      return transformarFalso(actual, p);
    };
    await masiva(c, "clasificar", { tipo: "dng" }, items(filas), {
      transformar,
    });
    expect(vistas).toHaveLength(3);
    expect(
      vistas.every(
        (v) => v.version === 1 && v.clienteId === c.id && v.periodo === PERIODO,
      ),
    ).toBe(true);
    expect(vistas.map((v) => v.id).sort()).toEqual(ids(filas).sort());
  });
});
