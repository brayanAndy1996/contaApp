import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUC_FIXTURE,
  comprasDe,
  descartarCompra,
  encolarDescarga,
  filaCompra,
  fijarEstadoPeriodo,
  limpiarCompras,
  mundoVentas,
  sembrarCompra,
  sembrarCompras,
  volcarTablasCompras,
  type MundoVentas,
} from "../../../test/compras.js";
import { esperarTerminal } from "../../../test/procesadores-007b.js";
import {
  alConfirmarTrasSentencia,
  arrancarConCiiu,
  cancelarPendientes,
  consultaFerreteria,
  contarEvaluacionesN,
  contarVersiones,
  ConsultaRucCiiu,
  ctxReevaluar,
  encolarReevaluar,
  exigirImplementado027,
  fijarUmbral,
  limpiarGastos,
  rgpDe,
  sembrarCiiu,
  sembrarPalabra,
  sembrarXmlMasivo,
  sembrarXmlSubido,
  volcarTablasGastos,
} from "../../../test/gastos.js";
import { fijarInterruptor, limpiarReglas } from "../../../test/reglas.js";
import { loggerEspia, volcado } from "../../../test/soporte.js";
import { BAJO_COBERTURA } from "../../../test/tiempos.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
} from "../../../test/trabajos.js";
import {
  EMISORES,
  canarioXml,
  esperarLotesXml,
  evaluacionesDe,
  limpiarXml,
  puertosXml,
} from "../../../test/xml.js";
import { reevaluarPeriodo } from "./reevaluar-periodo.js";

// Spec 027, T5 (rojo; integración con PostgreSQL y Redis reales): `compras.reevaluar` (R-8, R-12, R-5; CA-12, CA-15, CA-11).
//
// CONTRATO que fija (T11): `reevaluarPeriodo({ db, logger? })` es el `Procesador` de `compras.reevaluar` (parámetros `{ periodo }`).
// Recorre las compras vivas del periodo en lotes de 200, una transacción por lote que comprueba el periodo `abierto` (si dejó de
// estarlo, termina con lo hecho: `detenido`), arma el contexto con `contextoGastos` (solo lee la caché de CIIU: no consulta) y agrega
// la evaluación `n + 1` solo a las compras cuyos hallazgos cambian, sin crear versión ni mover el puntero. Devuelve solo conteos:
// `{ revisadas, cambiadas, detenido }`. Un periodo que no está `abierto` al empezar termina de inmediato con `detenido: true`.
//
// Mundo de las pruebas: la descarga de los 5 fixtures con el XML «no encontrado» (cada compra queda con su evaluación 1 sin XML);
// después se guarda el XML `subido` de F001-5070 (zapatillas) y la caché de CIIU (ferretería 4752 y tienda de calzado 4771).

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

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
// Las pruebas «directas» encolan el trabajo pero lo ejecutan sin pasar por la cola: quedan `en_cola` (ver generar-archivo.int.spec).
afterEach(async () => {
  await cancelarPendientes(admin, e?.estudios ?? []);
});

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  dbWorker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  e = new Escenario(admin);
  await exigirImplementado027(admin);
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0, reintentos: 1, base: 100 });
  await fijarConfig(admin, "xml", { global: 4, tenant: 2, espera: 0, reintentos: 1, base: 100 });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarGastos(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarXml(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos) await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), dbWorker?.close(), admin?.close()]);
});

const PERIODO = "202610";

interface ResultadoReevaluar {
  revisadas: number;
  cambiadas: number;
  detenido: boolean;
}

interface Intento {
  id: string;
  resultado?: ResultadoReevaluar;
  error?: Error;
}

/** Encola un trabajo nuevo y corre el procesador directo con el rol del worker. */
async function correr(
  m: MundoVentas,
  o: { periodo?: string; logger?: unknown; db?: ContappDb } = {},
): Promise<Intento> {
  const periodo = o.periodo ?? PERIODO;
  const { id } = await encolarReevaluar(admin, backend, redis, prefijo, m, periodo, { liberar: true });
  const proc = reevaluarPeriodo({
    db: o.db ?? dbWorker,
    ...(o.logger === undefined ? {} : { logger: o.logger as never }),
  });
  try {
    return { id, resultado: (await proc(ctxReevaluar(m, id, { periodo }))) as ResultadoReevaluar };
  } catch (error) {
    return { id, error: error as Error };
  }
}

/** Como `correr`, pero falla la prueba (con el error) si el procesador lanzó. */
async function reevaluar(m: MundoVentas, o: { periodo?: string; logger?: unknown } = {}): Promise<ResultadoReevaluar> {
  const r = await correr(m, o);
  if (r.error !== undefined) throw r.error;
  return r.resultado as ResultadoReevaluar;
}

/**
 * Descarga los 5 fixtures (el proveedor de XML no encuentra ninguno: cada compra queda con su evaluación 1 sin XML), con el
 * proveedor de F001-5070 ya conocido del cliente (otro periodo, puntaje 8) y la caché de CIIU sembrada.
 */
async function mundoDescargado(): Promise<MundoVentas> {
  const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
  await sembrarCompra(
    admin,
    m,
    filaCompra("77", { rucContraparte: EMISORES["5070"]!, fechaEmision: "2026-09-10" }),
    { periodo: "202609" },
  );
  const p = puertosXml();
  p.xml.mock.fallar("no_encontrado");
  // Un prefijo de Redis propio por mundo: una prueba puede armar dos y cada worker debe ver solo su cola.
  const propio = nuevoPrefijo();
  prefijos.push(propio);
  const w = await arrancarConCiiu(propio, p, new ConsultaRucCiiu());
  try {
    const id = await encolarDescarga(backend, redis, propio, m, { libro: "compras" });
    expect((await esperarTerminal(e, id, 30_000)).estado).toBe("completado");
    await esperarLotesXml(admin, m.c.id, 1, esperarHasta, 25_000);
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
  await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752");
  await sembrarCiiu(admin, m.T, EMISORES["5070"]!, "4771");
  return m;
}

/** Mundo con el XML `subido` de F001-5070 (zapatillas): lo guardado (evaluación 1) todavía no lo trae. */
async function mundoConXml(): Promise<MundoVentas> {
  const m = await mundoDescargado();
  await sembrarXmlSubido(admin, m, "5070");
  return m;
}

const porNumero = async (m: MundoVentas) => new Map((await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]));
const rondas = async (id: string) => (await evaluacionesDe(admin, id)).map((x) => [x.version_n, x.n]);

describe("CA-12 · R-8: «Volver a evaluar» en un periodo abierto", () => {
  it("lo guardado no cambia solo; al evaluar, solo la compra que cambia recibe la evaluación 2, sin versión nueva", async () => {
    const m = await mundoConXml();
    const compras = await porNumero(m);
    const id = compras.get("5070")!.id;
    const versiones = await contarVersiones(admin, m.c.id, PERIODO);
    // El XML ya está guardado, pero nadie re-evaluó: el hallazgo guardado sigue sin R-GP (R-8).
    expect(await rgpDe(admin, id, 1)).toBeNull();
    expect(await rondas(id)).toEqual([[1, 1]]);

    expect(await reevaluar(m)).toEqual({ revisadas: 5, cambiadas: 1, detenido: false });

    expect(await rondas(id)).toEqual([
      [1, 1],
      [1, 2],
    ]);
    const rgp = await rgpDe(admin, id, 2);
    expect(rgp!.sugerencia).toMatchObject({ tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 8 });
    expect(rgp!.sugerencia.senales.map((s) => s.codigo)).toEqual(["S1", "S2", "S3"]);
    expect(rgp!.requiere_confirmacion).toBe(true);
    // Sin tocar las demás: una sola evaluación y la misma versión.
    for (const [numero, c] of compras) {
      if (numero !== "5070") expect(await rondas(c.id), `evaluaciones de ${numero}`).toEqual([[1, 1]]);
      expect(c.version_vigente, numero).toBe(1);
    }
    expect(await contarVersiones(admin, m.c.id, PERIODO), "ninguna versión nueva").toBe(versiones);
    expect(await contarEvaluacionesN(admin, m.c.id, PERIODO, 2)).toBe(1);
    expect((await comprasDe(admin, m.c.id)).map((c) => c.version_vigente)).toEqual([1, 1, 1, 1, 1]);
  });

  it("una segunda vez sin cambios no agrega nada; las compras descartadas no se revisan", async () => {
    const m = await mundoConXml();
    const compras = await porNumero(m);
    const agregada = await sembrarCompra(admin, m, filaCompra("9001", { fechaEmision: "2026-10-20" }), {
      origen: "agregada",
    });
    await descartarCompra(admin, agregada);

    expect(await reevaluar(m)).toEqual({ revisadas: 5, cambiadas: 1, detenido: false });
    expect(await reevaluar(m)).toEqual({ revisadas: 5, cambiadas: 0, detenido: false });
    expect(await contarEvaluacionesN(admin, m.c.id, PERIODO, 2)).toBe(1);
    expect(await contarEvaluacionesN(admin, m.c.id, PERIODO, 3)).toBe(0);
    expect(await rondas(agregada), "la descartada queda como estaba").toEqual([]);
    expect(await rondas(compras.get("1040")!.id)).toEqual([[1, 1]]);
  });

  it("agregar una palabra no cambia lo guardado hasta evaluar; entonces la compra afectada recibe la evaluación 3", async () => {
    const m = await mundoConXml();
    const id = (await porNumero(m)).get("5070")!.id;
    await reevaluar(m);
    expect((await rgpDe(admin, id, 2))!.sugerencia.palabra).toBe("zapatilla");

    // «deportivas» (del estudio) va antes que «zapatilla» en el orden de código: la palabra del hallazgo cambia.
    await sembrarPalabra(admin, m, "deportivas", { categoria: "entretenimiento" });
    expect(await rondas(id), "sembrar la palabra no re-evalúa").toEqual([
      [1, 1],
      [1, 2],
    ]);

    expect(await reevaluar(m)).toEqual({ revisadas: 5, cambiadas: 1, detenido: false });
    expect(await rondas(id)).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
    expect((await rgpDe(admin, id, 3))!.sugerencia.palabra).toBe("deportivas");
    expect((await rgpDe(admin, id, 2))!.sugerencia.palabra, "la evaluación anterior se conserva").toBe("zapatilla");
  });

  it("el umbral nuevo rige al evaluar: subirlo a 9 quita el hallazgo (evaluación nueva) y bajarlo lo devuelve", async () => {
    const m = await mundoConXml();
    const id = (await porNumero(m)).get("5070")!.id;
    await fijarUmbral(admin, m, 9);
    // Con 9 el puntaje 8 no marca: nada cambia respecto de lo guardado, así que no se agrega evaluación.
    expect(await reevaluar(m)).toEqual({ revisadas: 5, cambiadas: 0, detenido: false });
    expect(await rondas(id)).toEqual([[1, 1]]);

    await fijarUmbral(admin, m, 3);
    expect((await reevaluar(m)).cambiadas).toBe(1);
    expect(await rgpDe(admin, id, 2)).not.toBeNull();

    await fijarUmbral(admin, m, 9);
    expect((await reevaluar(m)).cambiadas).toBe(1);
    expect(await rondas(id)).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
    expect(await rgpDe(admin, id, 3), "con el umbral 9 la evaluación 3 ya no marca").toBeNull();
  });

  it("con R-GP apagada en «Reglas del motor» no hay hallazgo ni puntaje en la evaluación nueva", async () => {
    const m = await mundoConXml();
    const id = (await porNumero(m)).get("5070")!.id;
    await reevaluar(m);
    expect(await rgpDe(admin, id, 2)).not.toBeNull();

    await fijarInterruptor(admin, m, "R-GP", false);
    expect((await reevaluar(m)).cambiadas).toBe(1);
    expect(await rgpDe(admin, id, 3)).toBeNull();
    expect(await rgpDe(admin, id, 2), "lo anterior no se borra").not.toBeNull();
  });

  it("solo toca las compras del cliente y estudio pedidos: otro estudio con el mismo escenario no cambia", async () => {
    const m = await mundoConXml();
    const otro = await mundoConXml();
    const idOtro = (await porNumero(otro)).get("5070")!.id;

    await reevaluar(m);

    expect(await rondas(idOtro), "el otro estudio no cambia").toEqual([[1, 1]]);
    expect(await rgpDe(admin, idOtro, 2)).toBeNull();
  });
});

describe("R-12: solo en un periodo abierto", () => {
  it.each(["revisado", "generado"] as const)("periodo %s: no hace nada (detenido, sin evaluaciones nuevas)", async (estado) => {
    const m = await mundoConXml();
    await fijarEstadoPeriodo(admin, m, estado);
    const antes = await contarEvaluacionesN(admin, m.c.id, PERIODO, 1);

    expect(await reevaluar(m)).toEqual({ revisadas: 0, cambiadas: 0, detenido: true });

    expect(await contarEvaluacionesN(admin, m.c.id, PERIODO, 2)).toBe(0);
    expect(await contarEvaluacionesN(admin, m.c.id, PERIODO, 1)).toBe(antes);
    expect(await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2)).toBeNull();
  });

  it("si el periodo se cierra a mitad del trabajo, termina con lo hecho (detenido) y no sigue evaluando", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarCompras(admin, m, 450); // tres lotes de 200 (200 + 200 + 50)
    await sembrarXmlMasivo(admin, m, 450);
    await fijarEstadoPeriodo(admin, m, "abierto");
    await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752");

    // Tras confirmar el primer lote que escribe una evaluación, otro usuario marca el periodo como revisado.
    const gancho = alConfirmarTrasSentencia(
      (dbWorker as unknown as { pool: unknown }).pool,
      /insert\s+into\s+compra_evaluacion/i,
      () => fijarEstadoPeriodo(admin, m, "revisado"),
    );
    let r: ResultadoReevaluar;
    try {
      r = await reevaluar(m);
    } finally {
      gancho.restaurar();
    }

    expect(gancho.disparos()).toBe(1);
    expect(r.detenido).toBe(true);
    expect(r.revisadas).toBeGreaterThan(0);
    expect(r.revisadas).toBeLessThan(450);
    expect(r.cambiadas).toBeGreaterThan(0);
    expect(r.cambiadas).toBeLessThanOrEqual(r.revisadas);
    const hechas = (
      await admin.pool.query(
        `select count(distinct e.compra_id)::int as n from compra_evaluacion e join compra c on c.id = e.compra_id
          where c.cliente_id = $1 and c.periodo = $2`,
        [m.c.id, PERIODO],
      )
    ).rows[0].n as number;
    expect(hechas, "lo escrito es exactamente lo que dice `cambiadas`").toBe(r.cambiadas);
  });
});

describe("R-12 · H-027-2-8: dos «Volver a evaluar» a la vez sobre el mismo periodo", () => {
  it("el primero se detiene a mitad, el segundo corre completo y el primero termina: ambos completos, sin 23505 ni 40P01 y todo con el diccionario nuevo", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarCompras(admin, m, 450); // tres lotes de 200 (200 + 200 + 50)
    await sembrarXmlMasivo(admin, m, 450);
    await fijarEstadoPeriodo(admin, m, "abierto");
    await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752");
    const versiones = await contarVersiones(admin, m.c.id, PERIODO);

    // Tras confirmar el primer lote del primer trabajo (evaluado con «zapatilla»), se agrega una palabra que marca las compras de
    // todos los lotes y corre COMPLETO el segundo trabajo; después el primero retoma por el segundo lote.
    let segundo: Intento | undefined;
    const gancho = alConfirmarTrasSentencia(
      (dbWorker as unknown as { pool: unknown }).pool,
      /insert\s+into\s+compra_evaluacion/i,
      async () => {
        await sembrarPalabra(admin, m, "deportivas", { categoria: "entretenimiento" });
        segundo = await correr(m);
      },
    );
    let primero: Intento;
    try {
      primero = await correr(m);
    } finally {
      gancho.restaurar();
    }

    expect(gancho.disparos()).toBe(1);
    expect(segundo, "el segundo trabajo corrió").toBeDefined();
    for (const [nombre, x] of [["primero", primero], ["segundo", segundo!]] as const) {
      const msg = x.error === undefined ? "" : `${nombre}: ${(x.error as { code?: string }).code ?? ""} ${x.error.name}`;
      expect(x.error, msg).toBeUndefined();
      expect(x.resultado!.detenido, `${nombre} no se detuvo`).toBe(false);
      expect(x.resultado!.revisadas, `${nombre} revisó todas`).toBe(450);
    }
    // El primero solo re-evaluó el lote que ya tenía hecho; el resto lo encontró al día con el contexto del último pedido.
    expect(primero.resultado!.cambiadas).toBe(200);
    expect(segundo!.resultado!.cambiadas).toBe(450);
    expect(await contarVersiones(admin, m.c.id, PERIODO), "ninguna versión nueva").toBe(versiones);

    const repetidas = await admin.pool.query(
      `select count(*)::int as n from (
         select e.compra_id, e.version_n, e.n from compra_evaluacion e join compra c on c.id = e.compra_id
          where c.cliente_id = $1 and c.periodo = $2 group by 1, 2, 3 having count(*) > 1) x`,
      [m.c.id, PERIODO],
    );
    expect(repetidas.rows[0].n, "ninguna (compra, version_n, n) repetida").toBe(0);

    // El hallazgo de la última evaluación de CADA compra es el del diccionario nuevo (y de cada compra hay una sola «última»).
    const finales = await admin.pool.query(
      `select c.id, ult.n, h.sugerencia->>'palabra' as palabra
         from compra c
         cross join lateral (select max(e.n) as n from compra_evaluacion e where e.compra_id = c.id and e.version_n = 1) ult
         left join compra_hallazgo h on h.compra_id = c.id and h.regla = 'R-GP' and h.version_n = 1 and h.evaluacion_n = ult.n
        where c.cliente_id = $1 and c.periodo = $2`,
      [m.c.id, PERIODO],
    );
    expect(finales.rows).toHaveLength(450);
    expect(finales.rows.filter((f: { palabra: string | null }) => f.palabra !== "deportivas")).toEqual([]);
    expect(await contarEvaluacionesN(admin, m.c.id, PERIODO, 1)).toBe(450);
    expect(await contarEvaluacionesN(admin, m.c.id, PERIODO, 2)).toBe(200);
    expect(await contarEvaluacionesN(admin, m.c.id, PERIODO, 3), "ninguna evaluación de más").toBe(0);
  });
});

describe("CA-15: volumen", () => {
  it("5.000 compras con XML se re-evalúan en menos de 20 s, todas con evaluación nueva y sin versiones nuevas", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarCompras(admin, m, 5000);
    await sembrarXmlMasivo(admin, m, 5000);
    await fijarEstadoPeriodo(admin, m, "abierto");
    await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752");
    const versiones = await contarVersiones(admin, m.c.id, PERIODO);

    const t0 = performance.now();
    const r = await reevaluar(m);
    const ms = performance.now() - t0;

    expect(r).toEqual({ revisadas: 5000, cambiadas: 5000, detenido: false });
    expect(await contarEvaluacionesN(admin, m.c.id, PERIODO, 1)).toBe(5000);
    expect(await contarVersiones(admin, m.c.id, PERIODO), "ninguna versión nueva").toBe(versiones);
    const gp = await admin.pool.query(
      `select count(*)::int as n from compra_hallazgo h join compra c on c.id = h.compra_id
        where c.cliente_id = $1 and c.periodo = $2 and h.regla = 'R-GP'`,
      [m.c.id, PERIODO],
    );
    expect(gp.rows[0].n).toBe(5000);
    if (!BAJO_COBERTURA) expect(ms, `5.000 compras tardaron ${Math.round(ms)} ms`).toBeLessThan(20_000);
  });
});

describe("CA-11 · R-5: el resultado solo lleva conteos y la glosa no sale de ella", () => {
  it("`resultado` es {revisadas, cambiadas, detenido}; un canario y <script> de la glosa no aparecen en resultado, logs, jobs ni tablas", async () => {
    const m = await mundoDescargado();
    const secreto = canarioXml("glosa");
    await sembrarXmlSubido(admin, m, "5070", {
      glosa: `ZAPATILLAS ${secreto} &lt;script&gt;alert(1)&lt;/script&gt;`,
    });
    const espia = loggerEspia();
    const r = await correr(m, { logger: espia.logger });
    expect(r.error, "el procesador no debía lanzar").toBeUndefined();

    const resultado = r.resultado!;
    expect(Object.keys(resultado).sort()).toEqual(["cambiadas", "detenido", "revisadas"]);
    expect(resultado).toEqual({ revisadas: 5, cambiadas: 1, detenido: false });
    expect((await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2))!.sugerencia).toMatchObject({
      palabra: "zapatilla",
      categoria: "calzado-ropa",
    });

    const visible = [
      volcado(resultado),
      volcado(espia.llamadas),
      await e.volcarJobs(),
      await volcarTablasCompras(admin, [m.T]),
      await volcarTablasGastos(admin, [m.T]),
      ...(
        await admin.pool.query("select to_jsonb(a)::text as t from auditoria a where tenant_id = $1", [m.T])
      ).rows.map((f: { t: string }) => f.t),
    ].join("\n");
    expect(visible).not.toContain(secreto);
    expect(visible).not.toContain("alert(1)");
    expect(visible).not.toContain("<script");
  });
});

describe("R-12: un trabajo por cliente y periodo (dedupe de 008)", () => {
  it("dos pedidos del mismo cliente y periodo comparten trabajo; otro periodo es otro trabajo", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const a = await encolarReevaluar(admin, backend, redis, prefijo, m, PERIODO);
    const b = await encolarReevaluar(admin, backend, redis, prefijo, m, PERIODO);
    expect(a.nuevo).toBe(true);
    expect(b.nuevo).toBe(false);
    expect(b.id).toBe(a.id);

    const c = await encolarReevaluar(admin, backend, redis, prefijo, m, "202609");
    expect(c.nuevo).toBe(true);
    expect(c.id).not.toBe(a.id);

    const filas = await admin.pool.query(
      "select count(*)::int as n from job_registro where cliente_id = $1 and tipo = 'compras.reevaluar'",
      [m.c.id],
    );
    expect(filas.rows[0].n).toBe(2);
  });
});

describe("registro: `compras.reevaluar` corre por la cola `xml`", () => {
  it("el worker lo ejecuta, termina completado con los conteos y no consulta ningún CIIU", async () => {
    const m = await mundoConXml();
    const consulta = consultaFerreteria(RUC_FIXTURE);
    const p = puertosXml();
    const w = await arrancarConCiiu(prefijo, p, consulta);
    try {
      const { id } = await encolarReevaluar(admin, backend, redis, prefijo, m, PERIODO);
      const fila = await esperarTerminal(e, id, 60_000);
      expect([fila.estado, fila.motivo]).toEqual(["completado", null]);
      expect(fila).toMatchObject({
        cola: "xml",
        canal: "ninguno",
        resultado: { revisadas: 5, cambiadas: 1, detenido: false },
      });
    } finally {
      await w.detener({ esperaMs: 2000 });
    }
    expect(consulta.rucs, "«Volver a evaluar» solo lee la caché").toEqual([]);
    expect(await rondas((await porNumero(m)).get("5070")!.id)).toEqual([
      [1, 1],
      [1, 2],
    ]);
  });
});
