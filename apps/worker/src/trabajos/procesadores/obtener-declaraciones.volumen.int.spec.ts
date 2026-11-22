import type { ContappDb } from "@contapp/db";
import { MockSolPortal } from "@contapp/sunat";
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
  guardarCredencial,
} from "../../../test/procesadores-007b.js";
import {
  asignarResponsable,
  limpiarFilas017,
} from "../../../test/notificaciones.js";
import {
  ESPERADO_DOCE,
  PERIODO_M,
  PortalPdt,
  VENTANA_12,
  encolarDeclaraciones,
  escrituras,
  exigirImplementado,
  limpiarProrrata,
  mundoProrrata,
  obtencionesDe,
  pdtDoce,
} from "../../../test/prorrata.js";
import { canario } from "../../../test/soporte.js";
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

// Spec 026, T5 (rojo; integración con PostgreSQL y Redis reales): volumen de CA-11.
//  (a) Obtener los 12 periodos con el MOCK de SOL termina en menos de 5 s (CI) y deja exactamente lo que entrega el mock.
//  (b) 300 clientes del mismo estudio piden a la vez: las llamadas a SOL nunca superan la concurrencia por tenant de la cola `sol`
//      (008), todos terminan y cada uno deja su obtención.
// CONTRATO que fija (T11): el de test/prorrata.ts (cabecera); sin tope de concurrencia propio del procesador (lo da la cola).

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const LIMITE_MS = 5_000;
const CLIENTES = 300;
const TENANT_CONCURRENCIA = 3;

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

describe("CA-11: 12 periodos con el mock de SOL", () => {
  it(`se obtienen en menos de ${LIMITE_MS / 1000} s y quedan exactamente las presentaciones del mock`, async () => {
    await exigirImplementado();
    await fijarConfig(admin, "sol", {
      global: 4,
      tenant: 2,
      espera: 0,
      reintentos: 1,
      base: 100,
    });
    // Control: el mock tiene el método del puerto (T9). Su oráculo es él mismo, llamado sin el worker.
    const mock = new MockSolPortal() as unknown as {
      obtenerDeclaraciones621?: (
        c: { ruc: string; usuarioSol: string; claveSol: string },
        o: { periodo: string },
      ) => Promise<unknown[]>;
    };
    if (typeof mock.obtenerDeclaraciones621 !== "function")
      throw new Error(
        "no implementado: MockSolPortal.obtenerDeclaraciones621 (spec 026, T9)",
      );

    const m = await mundoProrrata(e, admin, backend);
    const cred = { ruc: m.c.ruc, usuarioSol: "u", claveSol: "c" };
    let presentaciones = 0;
    let sinDeclaracion = 0;
    for (const periodo of VENTANA_12) {
      try {
        const r = await mock.obtenerDeclaraciones621(cred, { periodo });
        presentaciones += r.length;
        if (r.length === 0) sinDeclaracion += 1;
      } catch {
        sinDeclaracion += 1; // ErrorDatos del mock
      }
    }
    expect(presentaciones, "control: el mock trae PDT").toBeGreaterThan(0);
    expect(
      sinDeclaracion,
      "control: el mock trae meses sin declaración",
    ).toBeGreaterThan(0);

    const w = await arrancar007b({
      prefijo,
      solPortal: new MockSolPortal(),
    } as Parameters<typeof arrancar007b>[0]);
    let ms: number;
    let fila: Awaited<ReturnType<typeof esperarTerminal>>;
    try {
      const t0 = performance.now();
      const { id } = await encolarDeclaraciones(backend, redis, prefijo, m);
      fila = await esperarTerminal(e, id, 30_000);
      ms = performance.now() - t0;
    } finally {
      await w.detener({ esperaMs: 2000 });
    }

    expect([fila.estado, fila.motivo, fila.intentos]).toEqual([
      "completado",
      null,
      0,
    ]);
    expect(ms, `tardó ${Math.round(ms)} ms`).toBeLessThan(LIMITE_MS);
    expect((fila as { resultado?: unknown }).resultado).toEqual({
      periodosLeidos: 12,
      sinDeclaracion,
      nuevas: presentaciones,
    });
    expect((await escrituras(admin, [m.T])).declaraciones).toBe(presentaciones);
    expect((await obtencionesDe(admin, m.c.id))[0]).toMatchObject({
      periodo_hasta: PERIODO_M,
      nuevas: presentaciones,
    });
  });
});

describe("CA-11: 300 clientes del mismo estudio a la vez", () => {
  it(`no ocupan más de la concurrencia por tenant de la cola sol (${TENANT_CONCURRENCIA}), todos terminan y cada uno deja su obtención`, async () => {
    await exigirImplementado();
    await fijarConfig(admin, "sol", {
      global: 6,
      tenant: TENANT_CONCURRENCIA,
      espera: 0,
      reintentos: 1,
      base: 100,
      maxPendientes: 2000,
    });
    const T = await e.estudio();
    const u = await e.usuario(T, "contador");
    const secretos = {
      usuario: canario("usuario_sol"),
      clave: canario("clave_sol"),
    };
    const ids: { id: string; ruc: string }[] = [];
    // Siembra en tandas: cada cliente con su responsable y su credencial real (la descifra el worker).
    for (let i = 0; i < CLIENTES; i += 25) {
      const tanda = await Promise.all(
        Array.from({ length: Math.min(25, CLIENTES - i) }, async () => {
          const c = await e.cliente(T);
          await asignarResponsable(admin, T, c.id, u);
          await guardarCredencial(backend, T, c.id, "sol", secretos);
          return c;
        }),
      );
      ids.push(...tanda);
    }
    expect(new Set(ids.map((c) => c.ruc)).size, "RUC distintos").toBe(CLIENTES);

    const portal = new PortalPdt().todos(pdtDoce());
    portal.demoraMs = 2;
    const w = await arrancar007b({
      prefijo,
      solPortal: portal,
    } as Parameters<typeof arrancar007b>[0]);
    portal.contarTx = () => w.dbEstado.abiertas;
    const trabajos: string[] = [];
    const t0 = performance.now();
    try {
      for (let i = 0; i < ids.length; i += 25) {
        const tanda = await Promise.all(
          ids.slice(i, i + 25).map((c) =>
            encolarDeclaraciones(backend, redis, prefijo, {
              T,
              u,
              c,
            }),
          ),
        );
        trabajos.push(...tanda.map((x) => x.id));
      }
      expect(new Set(trabajos).size, "un trabajo por cliente").toBe(CLIENTES);
      await esperarHasta(
        async () => {
          const r = await admin.pool.query(
            `select count(*)::int as n from job_registro
              where tenant_id = $1 and tipo = 'sol.declaraciones.descargar' and estado in ('completado', 'error', 'cancelado')`,
            [T],
          );
          return r.rows[0].n === CLIENTES;
        },
        "los 300 trabajos terminan",
        { timeoutMs: 180_000, cadenciaMs: 250 },
      );
    } finally {
      await w.detener({ esperaMs: 5000 });
    }
    const ms = performance.now() - t0;

    const estados = await admin.pool.query(
      `select estado, motivo, count(*)::int as n from job_registro
        where tenant_id = $1 and tipo = 'sol.declaraciones.descargar' group by estado, motivo`,
      [T],
    );
    expect(estados.rows).toEqual([
      { estado: "completado", motivo: null, n: CLIENTES },
    ]);
    expect(
      portal.maxSimultaneas,
      `llamadas a SOL simultáneas (tardó ${Math.round(ms)} ms)`,
    ).toBeLessThanOrEqual(TENANT_CONCURRENCIA);
    expect(portal.maxSimultaneas, "sí hubo concurrencia").toBeGreaterThan(1);
    expect(portal.llamadas).toHaveLength(CLIENTES * 12);
    expect(await escrituras(admin, [T])).toEqual({
      obtenciones: CLIENTES,
      declaraciones: CLIENTES * ESPERADO_DOCE.nuevas,
    });
  });
});
