import type { ContappDb } from "@contapp/db";
import { ErrorPortal } from "@contapp/sunat";
import type { Redis } from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  arrancar007b,
  esperarTerminal,
  type FilaTrabajo,
} from "../../../test/procesadores-007b.js";
import {
  encolarRevisar,
  notificacionesTipo,
  descifradosDe,
  volcarTrazas,
} from "../../../test/buzon.js";
import {
  DML_PROHIBIDO,
  ESPERADO_DOCE,
  PERIODO_M,
  PortalPdt,
  VENTANA_12,
  TIPO_DECLARACIONES,
  comoFila,
  declaracionesDe,
  decl,
  encolarDeclaraciones,
  escrituras,
  espiarSentencias,
  limpiarProrrata,
  mundoProrrata,
  obtencionesDe,
  pdtDoce,
  transaccionDe,
  type MundoProrrata,
  type PdtPrueba,
} from "../../../test/prorrata.js";
import { auditoriaDe, limpiarFilas017 } from "../../../test/notificaciones.js";
import { fugas, loggerEspia, volcado } from "../../../test/soporte.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  dormir,
  fijarConfig,
  limpiarPrefijo,
  minimoTx,
  nuevoPrefijo,
  restaurarConfig,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../../test/trabajos.js";

// Spec 026, T5 (rojo; integración con PostgreSQL y Redis reales, BullMQ real y un doble de `SolPortal`): el procesador
// `sol.declaraciones.descargar` (D-1 a D-3, D-6, D-7; CA-1, CA-7, CA-10). Se encola como lo hace el backend (rol backend,
// `interactivo`) y lo ejecuta el worker, que es quien descifra con la KEK `mock`.
// CONTRATO que fija (T11): el de test/prorrata.ts (cabecera). Lo esencial:
// - Una llamada al puerto por periodo de la ventana, del más reciente al más antiguo, sin transacción abierta; lista vacía o
//   `ErrorDatos` = «sin declaración» y el resto sigue; una sola escritura (`registrarDeclaraciones`), sin SAVEPOINT.
// - `ErrorCredencial` -> `error/credencial_invalida` sin reintento, credencial `invalida` y NADA escrito; `ErrorTransitorio` -> se
//   reintenta; agotado -> `error/sunat_no_responde` sin escribir; `ErrorPortal` -> `error/portal_cambio` sin reintento.
// - `resultado` = {periodosLeidos, sinDeclaracion, nuevas}; ni clave, ni RUC, ni montos en logs, `resultado`, trazas ni auditoría.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const REINTENTOS = 2;
let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
let entornoAnterior: string | undefined;

beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(async () => {
  entornoAnterior = process.env.BUZON_PROGRAMADOR;
  process.env.BUZON_PROGRAMADOR = "off";
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  await fijarConfig(admin, "sol", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: REINTENTOS,
    base: 100,
  });
});

afterAll(async () => {
  if (entornoAnterior === undefined) delete process.env.BUZON_PROGRAMADOR;
  else process.env.BUZON_PROGRAMADOR = entornoAnterior;
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarProrrata(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarFilas017(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

const mundo = (): Promise<MundoProrrata> => mundoProrrata(e, admin, backend);

/** Arranca el worker con el portal de la prueba, corre `fn` y lo detiene. */
async function conWorker<T>(
  portal: PortalPdt,
  fn: (w: ProcesoWorker) => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const w = await arrancar007b({
    prefijo,
    solPortal: portal,
    ...extra,
  } as Parameters<typeof arrancar007b>[0]);
  portal.contarTx = () => w.dbEstado.abiertas;
  try {
    return await fn(w);
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

/** Encola una obtención (como el backend) y espera su fin. */
async function correr(
  m: MundoProrrata,
  periodo: string = PERIODO_M,
  timeoutMs = 40_000,
): Promise<FilaTrabajo> {
  const { id } = await encolarDeclaraciones(
    backend,
    redis,
    prefijo,
    m,
    periodo,
  );
  return esperarTerminal(e, id, timeoutMs);
}

const resultadoDe = (f: FilaTrabajo): Record<string, unknown> =>
  (f as { resultado?: Record<string, unknown> }).resultado ?? {};

/** Las presentaciones de un PDT de prueba, ordenadas como las lee la BD (periodo y número de orden). */
function presentaciones(pdt: PdtPrueba) {
  return Object.values(pdt)
    .flatMap((r) => (r === "error_datos" ? [] : r))
    .sort(
      (a, b) =>
        a.periodo.localeCompare(b.periodo) ||
        Number(a.numeroOrden) - Number(b.numeroOrden),
    );
}

const conteo = (v: unknown): number =>
  Array.isArray(v) ? v.length : typeof v === "number" ? v : Number.NaN;

const sinFilas = { obtenciones: 0, declaraciones: 0 };

// ---------------------------------------------------------------------------------------------------------------
// CA-1: los 12 periodos
// ---------------------------------------------------------------------------------------------------------------

describe("CA-1: obtener los 12 periodos de la ventana", () => {
  it("guarda las presentaciones (original y rectificatoria), anota los periodos «sin declaración» y audita la obtención", async () => {
    const m = await mundo();
    const pdt = pdtDoce();
    const portal = new PortalPdt().pdt(m.c.ruc, pdt);
    const f = await conWorker(portal, () => correr(m));
    expect([f.estado, f.motivo, f.intentos]).toEqual(["completado", null, 0]);
    expect(resultadoDe(f)).toEqual({
      periodosLeidos: ESPERADO_DOCE.periodosLeidos,
      sinDeclaracion: ESPERADO_DOCE.sinDeclaracion,
      nuevas: ESPERADO_DOCE.nuevas,
    });

    // Una llamada por periodo, del más reciente al más antiguo, con la credencial exacta.
    expect(portal.periodos(m.c.ruc)).toEqual(VENTANA_12);
    for (const c of portal.credenciales)
      expect(c).toEqual({
        ruc: m.c.ruc,
        usuarioSol: m.secretos.usuario,
        claveSol: m.secretos.clave,
      });
    expect(portal.llamadasBuzon, "no toca el buzón").toBe(0);

    // Las presentaciones, tal cual las entregó el portal (montos exactos), todas de la misma obtención.
    const filas = await declaracionesDe(admin, m.c.id);
    const obtenciones = await obtencionesDe(admin, m.c.id);
    expect(obtenciones).toHaveLength(1);
    expect(filas.map(({ obtencion_id, ...resto }) => resto)).toEqual(
      presentaciones(pdt).map(comoFila),
    );
    expect(filas.every((x) => x.obtencion_id === obtenciones[0]!.id)).toBe(
      true,
    );
    expect(filas.filter((x) => x.periodo === "202607")).toHaveLength(2);
    expect(filas.find((x) => x.periodo === "202610")?.prorrata_usada).toBe(
      "87.35",
    );

    // La obtención: periodos leídos (los 12) y «sin declaración» (lista vacía y ErrorDatos).
    const o = obtenciones[0]!;
    expect(o.periodo_hasta).toBe(PERIODO_M);
    expect(o.trabajo_id).toBe(f.id);
    expect(o.nuevas).toBe(ESPERADO_DOCE.nuevas);
    expect([...o.periodos_leidos].sort()).toEqual([...VENTANA_12].sort());
    expect([...o.periodos_sin_declaracion].sort()).toEqual([
      ...ESPERADO_DOCE.periodosSinDeclaracion,
    ]);

    // D-6: una auditoría con actor trabajo y sin RUC ni montos.
    const aud = await auditoriaDe(
      admin,
      m.T,
      "prorrata.declaraciones_obtenidas",
    );
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({
      actor_tipo: "trabajo",
      trabajo_id: f.id,
      cliente_id: m.c.id,
    });
    expect(aud[0]!.datos).toMatchObject({ periodo: PERIODO_M, nuevas: 11 });
    expect(conteo(aud[0]!.datos.leidos)).toBe(12);
    expect(conteo(aud[0]!.datos.sinDeclaracion)).toBe(2);
    expect(JSON.stringify(aud[0]!.datos)).not.toContain(m.c.ruc);

    // Se descifró una sola vez, con auditoría (D6 de 003).
    expect(await descifradosDe(admin, m.c.id)).toEqual([
      expect.objectContaining({ resultado: "ok" }),
    ]);
  });

  it("una segunda obtención no duplica filas (0 nuevas); una rectificatoria nueva del portal entra sola", async () => {
    const m = await mundo();
    const pdt = pdtDoce();
    const portal = new PortalPdt().pdt(m.c.ruc, pdt);
    await conWorker(portal, async () => {
      expect((await correr(m)).estado).toBe("completado");
      const antes = await declaracionesDe(admin, m.c.id);
      expect(antes).toHaveLength(11);

      const g = await correr(m);
      expect([g.estado, g.motivo]).toEqual(["completado", null]);
      expect(resultadoDe(g)).toEqual({
        periodosLeidos: 12,
        sinDeclaracion: 2,
        nuevas: 0,
      });
      expect(
        (await declaracionesDe(admin, m.c.id)).map(
          ({ obtencion_id, ...resto }) => resto,
        ),
      ).toEqual(antes.map(({ obtencion_id, ...resto }) => resto));
      const dos = await obtencionesDe(admin, m.c.id);
      expect(dos.map((o) => o.nuevas)).toEqual([11, 0]);

      // SUNAT trae una rectificatoria más del último periodo: solo esa fila es nueva.
      pdt["202610"] = [
        ...(pdt["202610"] as ReturnType<typeof decl>[]),
        decl("202610", {
          numeroOrden: "2026100002",
          tipo: "rectificatoria",
          fechaPresentacion: "2026-11-20",
          ventasGravadasBase: "141000.00",
        }),
      ];
      const h = await correr(m);
      expect(resultadoDe(h)).toEqual({
        periodosLeidos: 12,
        sinDeclaracion: 2,
        nuevas: 1,
      });
    });
    const filas = await declaracionesDe(admin, m.c.id);
    expect(filas).toHaveLength(12);
    expect(filas.filter((x) => x.periodo === "202610")).toHaveLength(2);
    expect(
      await auditoriaDe(admin, m.T, "prorrata.declaraciones_obtenidas"),
      "una auditoría por obtención, también la repetida",
    ).toHaveLength(3);
  });

  it.each([
    ["lista vacía en todos los periodos", [] as never],
    ["ErrorDatos en todos los periodos", "error_datos" as never],
  ])(
    "un cliente sin ningún PDT (%s): completa con 12 «sin declaración», 0 nuevas y deja la obtención",
    async (_n, respuesta) => {
      const m = await mundo();
      const todos: PdtPrueba = Object.fromEntries(
        VENTANA_12.map((p) => [p, respuesta]),
      );
      const portal = new PortalPdt().pdt(m.c.ruc, todos);
      const f = await conWorker(portal, () => correr(m));
      expect([f.estado, f.motivo]).toEqual(["completado", null]);
      expect(resultadoDe(f)).toEqual({
        periodosLeidos: 12,
        sinDeclaracion: 12,
        nuevas: 0,
      });
      expect(portal.periodos(m.c.ruc)).toEqual(VENTANA_12);
      expect(await declaracionesDe(admin, m.c.id)).toEqual([]);
      const o = await obtencionesDe(admin, m.c.id);
      expect(o).toHaveLength(1);
      expect([...o[0]!.periodos_sin_declaracion].sort()).toEqual(
        [...VENTANA_12].sort(),
      );
      expect(o[0]!.nuevas).toBe(0);
    },
  );

  it("la ventana cruza el año: de 2026-01 pide 202601 a 202502", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, {});
    await conWorker(portal, async () => {
      expect((await correr(m, "202601")).estado).toBe("completado");
    });
    expect(portal.periodos(m.c.ruc)).toEqual([
      "202601",
      "202512",
      "202511",
      "202510",
      "202509",
      "202508",
      "202507",
      "202506",
      "202505",
      "202504",
      "202503",
      "202502",
    ]);
    expect((await obtencionesDe(admin, m.c.id))[0]?.periodo_hasta).toBe(
      "202601",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// D-3, CA-7: errores del puerto
// ---------------------------------------------------------------------------------------------------------------

describe("CA-7: fallos del puerto no dejan nada escrito", () => {
  it("credencial inválida a la primera llamada: error `credencial_invalida` sin reintento, credencial `invalida`, aviso y nada escrito", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    portal.fallar("credencial");
    const f = await conWorker(portal, () => correr(m));
    expect([f.estado, f.motivo, f.intentos]).toEqual([
      "error",
      "credencial_invalida",
      0,
    ]);
    expect(portal.llamadas, "una sola llamada, sin reintento").toHaveLength(1);
    expect(await e.credencialEstado(m.c.id)).toMatchObject({
      estado: "invalida",
    });
    expect(
      await notificacionesTipo(admin, m.T, m.c.id, "credencial_invalida"),
    ).toHaveLength(1);
    expect(await escrituras(admin, [m.T])).toEqual(sinFilas);
    expect(
      await auditoriaDe(admin, m.T, "prorrata.declaraciones_obtenidas"),
    ).toEqual([]);
  });

  it("credencial rechazada a mitad de la ventana: ni siquiera lo leído hasta ahí se guarda", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    portal.fallar("credencial", { despuesDe: 5 });
    const f = await conWorker(portal, () => correr(m));
    expect([f.estado, f.motivo, f.intentos]).toEqual([
      "error",
      "credencial_invalida",
      0,
    ]);
    expect(portal.periodos(m.c.ruc)).toEqual(VENTANA_12.slice(0, 6));
    expect(await e.credencialEstado(m.c.id)).toMatchObject({
      estado: "invalida",
    });
    expect(await escrituras(admin, [m.T])).toEqual(sinFilas);
  });

  it("ErrorTransitorio a mitad: se reintenta, termina bien y la escritura única no duplica nada", async () => {
    const m = await mundo();
    const pdt = pdtDoce();
    const portal = new PortalPdt().pdt(m.c.ruc, pdt);
    portal.fallar("transitorio", { despuesDe: 3, veces: 1 });
    const f = await conWorker(portal, () => correr(m));
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    expect(f.intentos).toBeGreaterThanOrEqual(1);
    expect(portal.llamadas.length, "hubo un reintento").toBeGreaterThan(12);
    expect(resultadoDe(f)).toEqual({
      periodosLeidos: 12,
      sinDeclaracion: 2,
      nuevas: 11,
    });
    expect(await obtencionesDe(admin, m.c.id)).toHaveLength(1);
    expect(await declaracionesDe(admin, m.c.id)).toHaveLength(11);
    expect(await e.credencialEstado(m.c.id)).toMatchObject({
      estado: "configurada",
    });
  });

  it("ErrorTransitorio persistente: agota los reintentos, `sunat_no_responde` y nada escrito", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    portal.fallar("transitorio", { despuesDe: 2 });
    const f = await conWorker(portal, () => correr(m, PERIODO_M, 60_000));
    expect([f.estado, f.motivo, f.intentos]).toEqual([
      "error",
      "sunat_no_responde",
      REINTENTOS,
    ]);
    expect(await escrituras(admin, [m.T])).toEqual(sinFilas);
    expect(await e.credencialEstado(m.c.id)).toMatchObject({
      estado: "configurada",
    });
  });

  it("ErrorPortal (el portal cambió): `portal_cambio` sin reintento y nada escrito", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    portal.fallar("error", { despuesDe: 2, error: new ErrorPortal() });
    const f = await conWorker(portal, () => correr(m));
    expect([f.estado, f.motivo, f.intentos]).toEqual([
      "error",
      "portal_cambio",
      0,
    ]);
    expect(portal.llamadas).toHaveLength(3);
    expect(await escrituras(admin, [m.T])).toEqual(sinFilas);
  });

  it("cliente archivado mientras se leía el portal: termina `completado` sin escribir nada", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    portal.pausar();
    await conWorker(portal, async () => {
      const { id } = await encolarDeclaraciones(backend, redis, prefijo, m);
      await esperarHasta(
        () => portal.enEspera() > 0,
        "el portal recibe el pedido",
      );
      await admin.pool.query(
        "update cliente set archivado_at = now() where id = $1",
        [m.c.id],
      );
      portal.abrir();
      const f = await esperarTerminal(e, id);
      expect([f.estado, f.motivo]).toEqual(["completado", null]);
    });
    expect(await escrituras(admin, [m.T])).toEqual(sinFilas);
    expect(
      await auditoriaDe(admin, m.T, "prorrata.declaraciones_obtenidas"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-7, 008 D6: lectura fuera de la transacción, una sola escritura sin SAVEPOINT
// ---------------------------------------------------------------------------------------------------------------

describe("CA-7, 008 D6: el puerto se llama sin transacción y se escribe una sola vez", () => {
  it("ninguna de las 12 llamadas al puerto ocurre con una transacción del worker abierta", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    portal.pausar();
    await conWorker(portal, async (w) => {
      const { id } = await encolarDeclaraciones(backend, redis, prefijo, m);
      await esperarHasta(
        () => portal.enEspera() > 0,
        "el portal recibe el pedido",
      );
      expect(
        await minimoTx(w.dbEstado, 400),
        "una transacción abierta dejaría el mínimo en ≥ 1",
      ).toBe(0);
      portal.abrir();
      expect((await esperarTerminal(e, id)).estado).toBe("completado");
    });
    expect(portal.llamadas).toHaveLength(12);
    expect(portal.llamadas.map((l) => l.tx)).toEqual(Array(12).fill(0));
  });

  it("escribe con UNA sola llamada a prorrata_declaraciones_registrar, en una transacción sin SAVEPOINT ni DML directo", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    await conWorker(portal, async (w) => {
      const espia = espiarSentencias(w.db.pool);
      try {
        expect((await correr(m)).estado).toBe("completado");
      } finally {
        espia.restaurar();
      }
      const todas = espia.sentencias;
      expect(todas.length, "el espía sí vio sentencias").toBeGreaterThan(0);
      expect(
        todas.filter((s) => /savepoint/i.test(s.texto)).map((s) => s.texto),
        "SAVEPOINT",
      ).toEqual([]);
      const registrar = todas.filter((s) =>
        /prorrata_declaraciones_registrar/i.test(s.texto),
      );
      expect(registrar, "prorrata_declaraciones_registrar").toHaveLength(1);
      // Ni el trabajo ni la función tocan las tablas directamente: el DML directo no existe (grants), solo la función.
      expect(
        todas.filter((s) => DML_PROHIBIDO.test(s.texto)).map((s) => s.texto),
        "DML directo",
      ).toEqual([]);
      const tx = transaccionDe(todas, registrar[0]!);
      expect(tx.length).toBeGreaterThan(1);
      expect(tx[0]!.texto).toMatch(/^\s*begin/i);
      expect(tx[tx.length - 1]!.texto).toMatch(/^\s*commit/i);
    });
    expect(portal.llamadas).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-7: dedupe y serialización por RUC
// ---------------------------------------------------------------------------------------------------------------

describe("CA-7: dedupe por cliente y periodo", () => {
  it("dos pedidos del mismo cliente y periodo comparten trabajo; otro periodo es otro trabajo", async () => {
    const m = await mundo();
    const portal = new PortalPdt().todos(pdtDoce());
    portal.pausar();
    await conWorker(portal, async () => {
      const a = await encolarDeclaraciones(backend, redis, prefijo, m);
      expect(a.nuevo).toBe(true);
      await esperarHasta(
        () => portal.enEspera() > 0,
        "el portal recibe el pedido",
      );
      const b = await encolarDeclaraciones(backend, redis, prefijo, m);
      expect(b).toEqual({ id: a.id, nuevo: false });
      const otro = await encolarDeclaraciones(
        backend,
        redis,
        prefijo,
        m,
        "202609",
      );
      expect(otro.nuevo).toBe(true);
      expect(otro.id).not.toBe(a.id);
      portal.abrir();
      expect((await esperarTerminal(e, a.id)).estado).toBe("completado");
      expect((await esperarTerminal(e, otro.id)).estado).toBe("completado");
    });
    const trabajos = await admin.pool.query(
      "select count(*)::int as n from job_registro where cliente_id = $1 and tipo = $2",
      [m.c.id, TIPO_DECLARACIONES],
    );
    expect(trabajos.rows[0].n).toBe(2);
    expect(
      (await obtencionesDe(admin, m.c.id)).map((o) => o.periodo_hasta).sort(),
    ).toEqual(["202609", "202610"]);
  });
});

describe("CA-7: serialización con sol.buzon.revisar del mismo RUC", () => {
  it("con la captura del buzón de su RUC en curso, la obtención espera: nunca hay dos llamadas a SOL a la vez", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    portal.demoraMs = 30;
    portal.pausar();
    await conWorker(portal, async () => {
      const buzon = await encolarRevisar(backend, redis, prefijo, m);
      const pdt = await encolarDeclaraciones(backend, redis, prefijo, m);
      await esperarHasta(
        () => portal.enEspera() >= 1,
        "una de las dos llega al portal",
      );
      // La otra no puede empezar mientras la primera sigue dentro del portal.
      await dormir(500);
      expect(portal.enEspera()).toBe(1);
      portal.abrir();
      expect((await esperarTerminal(e, buzon)).estado).toBe("completado");
      expect((await esperarTerminal(e, pdt.id)).estado).toBe("completado");
    });
    expect(portal.maxSimultaneas).toBe(1);
    expect(portal.llamadasBuzon).toBeGreaterThan(0);
    expect(portal.llamadas.length).toBeGreaterThan(0);
    expect(await declaracionesDe(admin, m.c.id)).toHaveLength(11);
  });

  it("control: dos clientes de RUC distinto del mismo estudio sí consultan SOL a la vez (la medida no es vacía)", async () => {
    const a = await mundo();
    const b = await mundoProrrata(e, admin, backend, a);
    const portal = new PortalPdt().todos(pdtDoce());
    portal.pausar();
    await conWorker(portal, async () => {
      const ida = await encolarDeclaraciones(backend, redis, prefijo, a);
      const idb = await encolarDeclaraciones(backend, redis, prefijo, b);
      await esperarHasta(
        () => portal.enEspera() === 2,
        "las dos llegan al portal a la vez",
      );
      portal.abrir();
      expect((await esperarTerminal(e, ida.id)).estado).toBe("completado");
      expect((await esperarTerminal(e, idb.id)).estado).toBe("completado");
    });
    expect(portal.maxSimultaneas).toBe(2);
    expect(await declaracionesDe(admin, a.c.id)).toHaveLength(11);
    expect(await declaracionesDe(admin, b.c.id)).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-10, D-7: sin secretos, montos ni RUC en trazas
// ---------------------------------------------------------------------------------------------------------------

describe("CA-10: canarios en usuario, clave, RUC y montos del PDT", () => {
  it("no aparecen en logs, `resultado`, trabajos, Redis, notificaciones ni auditoría, ni siquiera cuando el portal falla con ellos", async () => {
    const m = await mundo();
    const montoBase = "31415926.53";
    const montoIgv = "27182818.28";
    const pdt = pdtDoce();
    pdt["202609"] = [
      decl("202609", {
        ventasGravadasBase: montoBase,
        ventasGravadasIgv: montoIgv,
      }),
    ];
    const portal = new PortalPdt().pdt(m.c.ruc, pdt);
    // Un fallo cuyo mensaje trae todos los canarios: el ejecutor no debe copiarlo a ningún lado.
    portal.fallar("error", {
      despuesDe: 4,
      veces: 1,
      error: new Error(
        `portal: ${m.secretos.usuario} ${m.secretos.clave} ${m.c.ruc} ${montoBase} ${montoIgv}`,
      ),
    });
    const espiaLog = loggerEspia();
    const f = await conWorker(portal, () => correr(m), {
      logger: espiaLog.logger,
    });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    expect(
      (await declaracionesDe(admin, m.c.id)).find(
        (x) => x.periodo === "202609",
      ),
      "el dato sí está, en su tabla",
    ).toMatchObject({ ventas_gravadas_base: montoBase });

    const secretos = [
      m.secretos.usuario,
      m.secretos.clave,
      montoBase,
      montoIgv,
    ];
    const dondeBuscar: Record<string, unknown> = {
      logs: volcado(espiaLog.llamadas),
      trazasBd: await volcarTrazas(admin, e.estudios),
      redis: await volcarPrefijo(redis, prefijo),
      resultado: JSON.stringify(resultadoDe(f)),
    };
    for (const [donde, texto] of Object.entries(dondeBuscar))
      expect(fugas(texto as string, secretos), donde).toEqual([]);

    // El RUC tampoco: ni en logs, ni en `resultado`, ni en los `datos` de la auditoría de la prorrata.
    const auditoria = (await auditoriaDe(admin, m.T))
      .filter((a) => a.accion.startsWith("prorrata."))
      .map((a) => a.datos);
    expect(auditoria.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditoria)).not.toContain(m.c.ruc);
    expect(JSON.stringify(auditoria)).not.toContain(montoBase);
    expect(volcado(espiaLog.llamadas)).not.toContain(m.c.ruc);
    expect(JSON.stringify(resultadoDe(f))).not.toContain(m.c.ruc);
  });
});
