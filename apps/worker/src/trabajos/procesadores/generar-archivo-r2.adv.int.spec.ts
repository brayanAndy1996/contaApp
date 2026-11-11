import {
  bloquearPeriodoLibro,
  excluirVenta,
  fijarEstadoPeriodoVentas,
  leerEstadoPeriodoVentas,
  restaurarVenta,
  type ContappDb,
} from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlmacenEspia,
  PERIODO,
  ctxDe,
  encolarGenerar,
  estadoDe,
  fijarEstado,
  huellaDe,
  limpiarArchivos,
  sembrarComprasBase,
  sembrarExclusion,
  sembrarVentaSire,
  sha256Hex,
  ventaFactura,
  versionesDe,
  type Libro,
  type ParametrosGenerar,
} from "../../../test/archivos.js";
import { RUC_FIXTURE, limpiarCompras, nuevaVersion } from "../../../test/compras.js";
import { arrancar007b, esperarTerminal } from "../../../test/procesadores-007b.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
} from "../../../test/trabajos.js";
import { mundoVentas, sembrarPropuesta, type MundoVentas } from "../../../test/ventas.js";
import { ErrorDatos } from "@contapp/sunat";
import { persistidorVentas } from "../persistidores/ventas.js";
import { ErrorArchivo, generarArchivo, type ResultadoGenerarArchivo } from "./generar-archivo.js";

// Spec 012b, T20 (ronda adversarial 2): concurrencia, estados, huella y cola del procesador `archivo.generar` (D4, D5, D6,
// D12, P-2, P-5; CA-7, CA-8, CA-14). Caja negra contra el contrato del procesador y caja blanca contra
// `generar-archivo.ts` y el orden de bloqueo del plan. Las escrituras concurrentes del backend se reproducen con las mismas
// funciones de `@contapp/db` y en el mismo orden que `exigirEscrituraVentas` + `ExclusionVentasService` / `EstadoVentasService`
// (advisory del libro -> `venta_periodo FOR SHARE` -> fila), con el rol del backend.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let dbWorker: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

let configOriginal: Record<string, unknown> | undefined;

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend", 6);
  dbWorker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  e = new Escenario(admin);
  configOriginal = (await admin.pool.query("select * from config_sistema where cola = 'archivos'")).rows[0] as
    | Record<string, unknown>
    | undefined;
});

afterAll(async () => {
  if (configOriginal !== undefined) {
    const c = configOriginal;
    await admin.pool
      .query(
        `update config_sistema set concurrencia_global = $2, concurrencia_tenant = $3, espera_ruc_ms = $4, reintentos = $5,
           backoff_base_ms = $6, max_pendientes_tenant = $7, actualizado_en = now() where cola = $1`,
        [
          "archivos",
          c.concurrencia_global,
          c.concurrencia_tenant,
          c.espera_ruc_ms,
          c.reintentos,
          c.backoff_base_ms,
          c.max_pendientes_tenant,
        ],
      )
      .catch(() => undefined);
  }
  await limpiarArchivos(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos) await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), dbWorker?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

const mundo = (): Promise<MundoVentas> => mundoVentas(e, backend, { ruc: RUC_FIXTURE });

const pausa = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function diferido(): { promesa: Promise<void>; resolver: () => void } {
  let resolver!: () => void;
  const promesa = new Promise<void>((r) => {
    resolver = r;
  });
  return { promesa, resolver };
}

/** Storage cuyo `guardar` se detiene (tras guardar) mientras la compuerta está cerrada: el worker queda DENTRO de su transacción. */
class AlmacenCompuerta extends AlmacenEspia {
  private abierta = diferido();
  private dentro = diferido();
  constructor(private readonly filtro: (ruta: string) => boolean = () => true) {
    super();
  }
  override async guardar(ruta: string, bytes: Uint8Array): Promise<void> {
    await super.guardar(ruta, bytes);
    if (!this.filtro(ruta)) return;
    this.dentro.resolver();
    await this.abierta.promesa;
  }
  esperarDentro(): Promise<void> {
    return this.dentro.promesa;
  }
  abrir(): void {
    this.abierta.resolver();
  }
}

async function parametros(m: MundoVentas, libro: Libro, periodo = PERIODO): Promise<ParametrosGenerar> {
  return { periodo, libro, estadoVisto: "abierto", huella: await huellaDe(admin, m, libro, periodo) };
}

async function correr(
  m: MundoVentas,
  db: Pick<ContappDb, "withTenant">,
  almacen: AlmacenEspia,
  p: ParametrosGenerar,
  trabajoId?: string,
): Promise<{ id: string; resultado?: ResultadoGenerarArchivo; error?: Error }> {
  const id = trabajoId ?? (await encolarGenerar(admin, backend, redis, prefijo, m, p));
  try {
    return { id, resultado: (await generarArchivo({ db, storage: almacen })(ctxDe(m, id, p))) as ResultadoGenerarArchivo };
  } catch (error) {
    return { id, error: error as Error };
  }
}

/** Ventas con la venta descuadrada F001-3 excluida (previo apto) y dos buenas. Devuelve el id de la descuadrada. */
async function ventasConExcluida(m: MundoVentas, periodo = PERIODO): Promise<string> {
  const prop = await sembrarPropuesta(admin, m, { filas: 3, periodo });
  const fecha = `${periodo.slice(0, 4)}-${periodo.slice(4)}-05`;
  await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "1", { fechaEmision: fecha }), { periodo });
  await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "2", { fechaEmision: fecha }), { periodo });
  const mala = await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "3", { fechaEmision: fecha, total: "119.00" }), {
    periodo,
  });
  await sembrarExclusion(admin, m, mala, "descuadrada en el SIRE", { periodo });
  return mala;
}

/**
 * Una escritura de ventas del backend con el orden de `exigirEscrituraVentas` (advisory del libro y `venta_periodo FOR SHARE`),
 * que se queda abierta hasta `soltar`. Devuelve el estado que leyó bajo el bloqueo.
 */
function escrituraVentas(
  m: MundoVentas,
  accion: (tx: Parameters<Parameters<ContappDb["withTenant"]>[1]>[0], estado: string) => Promise<void>,
  soltar: Promise<void>,
  periodo = PERIODO,
): { bloqueada: Promise<void>; fin: Promise<string> } {
  const tomada = diferido();
  const fin = backend.withTenant({ tenantId: m.T, userId: m.u }, async (tx) => {
    await bloquearPeriodoLibro(tx, m.c.id, periodo, "ventas");
    const { estado } = await leerEstadoPeriodoVentas(tx, m.c.id, periodo, { compartido: true });
    tomada.resolver();
    if (estado === "abierto") await accion(tx, estado);
    await soltar;
    return estado;
  });
  return { bloqueada: tomada.promesa, fin };
}

// ---------------------------------------------------------------------------------------------------------------
// D4 / D6: el acuse del COMMIT se pierde
// ---------------------------------------------------------------------------------------------------------------

describe("D4 / D6 · el COMMIT ocurrió pero su acuse se perdió", () => {
  it("ADV-012b-r2-1: el ZIP de una versión confirmada no se borra y el reintento entrega una versión descargable", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const p = await parametros(m, "compras");
    // `withTenant` real (la transacción se confirma en la BD) y después la conexión "se corta" al leer la respuesta del COMMIT.
    const dbAcusePerdido: Pick<ContappDb, "withTenant"> = {
      withTenant: (async (ctx: never, fn: never) => {
        await dbWorker.withTenant(ctx, fn);
        throw new Error("Connection terminated unexpectedly");
      }) as ContappDb["withTenant"],
    };

    const primero = await correr(m, dbAcusePerdido, almacen, p);
    expect(primero.error, "el intento debe fallar como transitorio (008 lo reintenta)").toBeDefined();
    const [v] = await versionesDe(admin, m.c.id);
    expect(v, "la versión quedó confirmada en la BD").toBeDefined();

    // El reintento (D6) devuelve la versión confirmada; su ZIP tiene que existir y coincidir con `sha256_zip`.
    const reintento = await correr(m, dbWorker, almacen, p, primero.id);
    expect(reintento.resultado).toMatchObject({ archivoId: v!.id, version: 1, nueva: false });
    expect(almacen.rutas(), "el ZIP de la versión confirmada fue borrado como si fuera huérfano").toContain(v!.ruta);
    expect(sha256Hex(await almacen.leer(v!.ruta))).toBe(v!.sha_zip);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// D6 / P-5: TXT idéntico con otra huella, y el reintento del mismo trabajo
// ---------------------------------------------------------------------------------------------------------------

describe("D6 / P-5 · reintento de un trabajo que terminó por el camino del TXT idéntico", () => {
  it("ADV-012b-r2-2: clasificar sin cambiar montos, regenerar (nueva:false) y repetir el MISMO trabajo devuelve la misma versión", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    const v1 = await correr(m, dbWorker, almacen, await parametros(m, "compras"));
    expect(v1.error).toBeUndefined();

    // Reabrir y clasificar una fila: nueva versión de la compra con los mismos montos (el TXT no cambia; la huella sí).
    await fijarEstado(admin, "compras", m, "abierto");
    await nuevaVersion(admin, m, base.a, { clasificada: true, accion: "clasificar" });
    const p2 = await parametros(m, "compras");

    const segundo = await correr(m, dbWorker, almacen, p2);
    expect(segundo.error).toBeUndefined();
    expect(segundo.resultado).toEqual({ ...v1.resultado, nueva: false }); // P-5: TXT idéntico
    expect(p2.huella).not.toBe((await versionesDe(admin, m.c.id))[0]!.huella); // la versión devuelta guarda otra huella

    // El commit de `segundo` ocurrió; su acuse a 008 se pierde y el MISMO trabajo se repite (CA-7).
    const repetido = await correr(m, dbWorker, almacen, p2, segundo.id);
    expect(repetido.error, `CA-7: el reintento falló con ${(repetido.error as ErrorArchivo | undefined)?.detalle}`).toBeUndefined();
    expect(repetido.resultado).toEqual(segundo.resultado);
  });
});

describe("D5 / D6 · reintento tardío de un trabajo ya confirmado después de reabrir", () => {
  it("ADV-012b-r2-11: reabrir y que llegue el reintento del trabajo viejo no vuelve a cerrar el periodo reabierto", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const p = await parametros(m, "compras");
    const primero = await correr(m, dbWorker, almacen, p);
    expect(primero.error).toBeUndefined();

    // El acuse del commit a 008 se perdió; mientras tanto el contador reabre (como la ruta de 014) para corregir algo.
    await fijarEstado(admin, "compras", m, "abierto");
    const reintento = await correr(m, dbWorker, almacen, p, primero.id);

    // El reintento puede devolver la versión ya hecha (D6), pero no debe deshacer el «reabrir» de otra persona: el periodo
    // reabierto después de la versión sigue `abierto` (D5: generar parte del estado que vio quien pidió, no de uno posterior).
    expect(reintento.resultado?.archivoId ?? primero.resultado?.archivoId).toBe(primero.resultado?.archivoId);
    expect((await estadoDe(admin, "compras", m.c.id))?.estado, "el reintento tardío volvió a cerrar el periodo").toBe("abierto");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// D4 / D12: excluir y restaurar contra generar, en los dos órdenes
// ---------------------------------------------------------------------------------------------------------------

describe("D4 / D12 · restaurar una venta excluida contra generar", () => {
  it("ADV-012b-r2-3: restaurar en curso cuando arranca el worker: el worker espera y falla con resumen_cambiado, sin rastro (3 rondas)", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const periodo = `2026${String(ronda + 1).padStart(2, "0")}`;
      const m = await mundo();
      const almacen = new AlmacenEspia();
      const mala = await ventasConExcluida(m, periodo);
      const p = await parametros(m, "ventas", periodo);
      const soltar = diferido();
      const w = escrituraVentas(m, async (tx) => void (await restaurarVenta(tx, mala, m.u)), soltar.promesa, periodo);
      await w.bloqueada;

      const generando = correr(m, dbWorker, almacen, p);
      await pausa(300);
      soltar.resolver();
      expect(await w.fin).toBe("abierto");
      const r = await generando;

      expect(r.error, `ronda ${ronda}`).toBeInstanceOf(ErrorArchivo);
      expect((r.error as ErrorArchivo).detalle).toBe("resumen_cambiado");
      expect(await versionesDe(admin, m.c.id)).toEqual([]);
      expect(almacen.intentosGuardar).toEqual([]);
      expect((await estadoDe(admin, "ventas", m.c.id, periodo))?.estado).toBe("abierto");
    }
  });

  it("ADV-012b-r2-4: el worker ya está dentro (guardando el ZIP): restaurar y excluir esperan y luego leen `generado` (409)", async () => {
    const m = await mundo();
    const almacen = new AlmacenCompuerta();
    const mala = await ventasConExcluida(m);
    const prop = await sembrarPropuesta(admin, m, { filas: 1 });
    const otraMala = await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "4", { total: "200.00" }));
    // La segunda descuadrada también se excluye antes del previo; la escritura concurrente intenta restaurar una y re-excluir.
    await sembrarExclusion(admin, m, otraMala, "otra descuadrada");
    const p = await parametros(m, "ventas");

    const generando = correr(m, dbWorker, almacen, p);
    await almacen.esperarDentro();
    let escribio = false;
    const w1 = escrituraVentas(
      m,
      async (tx) => {
        escribio = (await restaurarVenta(tx, mala, m.u)) || escribio;
      },
      Promise.resolve(),
    );
    const w2 = escrituraVentas(
      m,
      async (tx) => {
        escribio = (await excluirVenta(tx, { clienteId: m.c.id, periodo: PERIODO, ventaId: mala, motivo: "x", usuarioId: m.u })) !== null || escribio;
      },
      Promise.resolve(),
    );
    await pausa(300);
    almacen.abrir();
    const r = await generando;

    expect(r.error).toBeUndefined();
    expect(r.resultado?.nueva).toBe(true);
    expect(await w1.fin).toBe("generado");
    expect(await w2.fin).toBe("generado");
    expect(escribio).toBe(false);
    const [v] = await versionesDe(admin, m.c.id);
    expect(v!.excluidas).toBe(2);
    expect(v!.huella).toBe(p.huella);
  });

  it("ADV-012b-r2-5: revisar (FOR UPDATE, sin advisory) mientras el worker está dentro espera y no pisa `generado`; reabrir después sí", async () => {
    const m = await mundo();
    const almacen = new AlmacenCompuerta();
    await ventasConExcluida(m);
    const p = await parametros(m, "ventas");

    const generando = correr(m, dbWorker, almacen, p);
    await almacen.esperarDentro();
    const revisar = backend.withTenant({ tenantId: m.T, userId: m.u }, (tx) =>
      fijarEstadoPeriodoVentas(tx, m.c.id, PERIODO, "abierto", "revisado", m.u),
    );
    await pausa(300);
    almacen.abrir();
    const r = await generando;

    expect(r.error).toBeUndefined();
    expect(await revisar).toBeNull();
    expect(await estadoDe(admin, "ventas", m.c.id)).toMatchObject({ estado: "generado", marcado_por: m.u });
    const reabierto = await backend.withTenant({ tenantId: m.T, userId: m.u }, (tx) =>
      fijarEstadoPeriodoVentas(tx, m.c.id, PERIODO, "generado", "abierto", m.u),
    );
    expect(reabierto?.estado).toBe("abierto");
    expect(await versionesDe(admin, m.c.id)).toHaveLength(1);
  });
});

describe("D5 · la descarga de ventas del worker contra generar", () => {
  it("ADV-012b-r2-12: con generar dentro, la descarga (advisory + `leerExistentes`) espera y termina en ErrorDatos por `generado`", async () => {
    const m = await mundo();
    const almacen = new AlmacenCompuerta();
    await ventasConExcluida(m);
    const p = await parametros(m, "ventas");

    const generando = correr(m, dbWorker, almacen, p);
    await almacen.esperarDentro();
    // El orden de `aplicarComplemento` (advisory del libro) y luego el persistidor real de ventas, con el rol del worker.
    const descarga = dbWorker
      .withTenant({ tenantId: m.T }, async (tx) => {
        await bloquearPeriodoLibro(tx, m.c.id, PERIODO, "ventas");
        await persistidorVentas.leerExistentes(tx, { clienteId: m.c.id, periodo: PERIODO });
        return "leyo";
      })
      .catch((err: unknown) => err);
    await pausa(300);
    almacen.abrir();

    expect((await generando).error).toBeUndefined();
    expect(await descarga).toBeInstanceOf(ErrorDatos);
    expect(await versionesDe(admin, m.c.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Compras y ventas del mismo periodo a la vez
// ---------------------------------------------------------------------------------------------------------------

describe("compras y ventas del mismo periodo a la vez", () => {
  it("ADV-012b-r2-6: los dos libros generan su versión 1 sin esperarse ni mezclarse (3 rondas)", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const periodo = `2026${String(ronda + 6).padStart(2, "0")}`;
      const m = await mundo();
      const almacen = new AlmacenEspia();
      await sembrarComprasBase(admin, m, { periodo });
      await ventasConExcluida(m, periodo);
      const [pc, pv] = [await parametros(m, "compras", periodo), await parametros(m, "ventas", periodo)];

      const [rc, rv] = await Promise.all([correr(m, dbWorker, almacen, pc), correr(m, dbWorker, almacen, pv)]);

      expect(rc.error, `compras, ronda ${ronda}`).toBeUndefined();
      expect(rv.error, `ventas, ronda ${ronda}`).toBeUndefined();
      const vs = await versionesDe(admin, m.c.id, { periodo });
      expect(vs.map((v) => [v.libro, v.version]).sort()).toEqual([
        ["compras", 1],
        ["ventas", 1],
      ]);
      expect(vs.find((v) => v.libro === "compras")!.huella).toBe(pc.huella);
      expect(vs.find((v) => v.libro === "ventas")!.huella).toBe(pv.huella);
      expect((await estadoDe(admin, "compras", m.c.id, periodo))?.estado).toBe("generado");
      expect((await estadoDe(admin, "ventas", m.c.id, periodo))?.estado).toBe("generado");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Cola: un estudio con muchos trabajos frente a otro
// ---------------------------------------------------------------------------------------------------------------

describe("cola `archivos` · un estudio con muchos trabajos frente a otro", () => {
  it("ADV-012b-r2-7: con 5 trabajos de A atascados en storage, A no pasa de su cupo y el trabajo de B termina", async () => {
    await fijarConfig(admin, "archivos", { global: 4, tenant: 2, espera: 0, reintentos: 0, base: 100 });
    const a = await mundo();
    const b = await mundo();
    const almacen = new AlmacenCompuerta((ruta) => ruta.startsWith(`archivos/${a.T}/`));
    const periodosA = ["202601", "202602", "202603", "202604", "202605"];
    for (const periodo of periodosA) await sembrarComprasBase(admin, a, { periodo });
    await sembrarComprasBase(admin, b);
    const w = await arrancar007b({ prefijo, storage: almacen } as Parameters<typeof arrancar007b>[0]);
    try {
      const idsA: string[] = [];
      for (const periodo of periodosA)
        idsA.push(await encolarGenerar(admin, backend, redis, prefijo, a, await parametros(a, "compras", periodo), { liberar: false }));
      await almacen.esperarDentro();
      const idB = await encolarGenerar(admin, backend, redis, prefijo, b, await parametros(b, "compras"), { liberar: false });

      const filaB = await esperarTerminal(e, idB, 30_000);
      expect(filaB.estado).toBe("completado");
      const dentroA = almacen.intentosGuardar.filter((r) => r.startsWith(`archivos/${a.T}/`));
      expect(dentroA.length, "A superó su concurrencia por estudio").toBeLessThanOrEqual(2);

      almacen.abrir();
      for (const id of idsA) expect((await esperarTerminal(e, id, 60_000)).estado).toBe("completado");
      expect(await versionesDe(admin, a.c.id)).toHaveLength(5);
    } finally {
      almacen.abrir();
      await w.detener({ esperaMs: 3000 });
    }
  });
});
