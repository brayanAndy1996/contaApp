// Spec 026 · T15 (adversario, ronda 1) del trabajo `sol.declaraciones.descargar` con PostgreSQL, Redis y BullMQ reales y un doble del
// portal: payload con periodo futuro (R-1), dos obtenciones de periodos distintos del mismo cliente y la revisión del buzón del mismo
// RUC a la vez (bloqueo por RUC de 008), y 300 clientes de un estudio frente a uno de otro estudio (reparto por tenant de la cola `sol`).
// Caja blanca: el catálogo valida `{periodo}` solo por forma (AAAAMM), el procesador no mira el reloj y 0066 no lo compara con el mes en
// curso, así que nada impide leer SOL ni registrar una ventana futura.
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { arrancar007b, esperarTerminal, guardarCredencial } from "../../../test/procesadores-007b.js";
import { encolarRevisar } from "../../../test/buzon.js";
import { asignarResponsable, limpiarFilas017 } from "../../../test/notificaciones.js";
import {
  PortalPdt,
  declaracionesDe,
  encolarDeclaraciones,
  limpiarProrrata,
  mundoProrrata,
  obtencionesDe,
  pdtDoce,
  type MundoProrrata,
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

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

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
  for (const x of prefijos) await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

const mundo = (): Promise<MundoProrrata> => mundoProrrata(e, admin, backend);

async function conWorker<T>(portal: PortalPdt, fn: () => Promise<T>): Promise<T> {
  const w = await arrancar007b({ prefijo, solPortal: portal } as Parameters<typeof arrancar007b>[0]);
  portal.contarTx = () => w.dbEstado.abiertas;
  try {
    return await fn();
  } finally {
    await w.detener({ esperaMs: 5000 });
  }
}

/** Mes siguiente al en curso en hora de Lima (UTC-5), AAAAMM. */
function mesSiguienteLima(): string {
  const lima = new Date(Date.now() - 5 * 3_600_000);
  const a = lima.getUTCFullYear();
  const m = lima.getUTCMonth() + 1;
  return m === 12 ? `${a + 1}01` : `${a}${String(m + 1).padStart(2, "0")}`;
}

// ===========================================================================================================================
describe("payload con periodo futuro (R-1)", () => {
  it("un trabajo cuyo periodo es posterior al mes en curso no se encola o termina sin llamar a SOL ni escribir nada", async () => {
    await fijarConfig(admin, "sol", { global: 4, tenant: 2, espera: 0, reintentos: 1, base: 100 });
    const m = await mundo();
    const futuro = mesSiguienteLima();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    await conWorker(portal, async () => {
      let id: string | null = null;
      try {
        id = (await encolarDeclaraciones(backend, redis, prefijo, m, futuro)).id;
      } catch {
        id = null; // rechazado al encolar: correcto
      }
      if (id !== null) await esperarTerminal(e, id, 40_000);
    });
    expect(portal.periodos(m.c.ruc), `SOL consultado para la ventana de ${futuro}`).toEqual([]);
    expect(await obtencionesDe(admin, m.c.id)).toHaveLength(0);
    expect(await declaracionesDe(admin, m.c.id)).toHaveLength(0);
  });
});

// ===========================================================================================================================
describe("dos obtenciones ∥ revisión del buzón del mismo RUC (008: bloqueo por RUC; CA-7)", () => {
  it("nunca hay dos llamadas a SOL a la vez, los tres terminan y las presentaciones compartidas no se duplican", async () => {
    await fijarConfig(admin, "sol", { global: 6, tenant: 3, espera: 0, reintentos: 1, base: 100 });
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtDoce());
    portal.demoraMs = 15;
    await conWorker(portal, async () => {
      const [buzon, o1, o2] = await Promise.all([
        encolarRevisar(backend, redis, prefijo, m),
        encolarDeclaraciones(backend, redis, prefijo, m, "202610"),
        encolarDeclaraciones(backend, redis, prefijo, m, "202609"),
      ]);
      expect(o1.id).not.toBe(o2.id);
      const fin = await Promise.all([buzon, o1.id, o2.id].map((id) => esperarTerminal(e, id, 60_000)));
      expect(fin.map((f) => f.estado)).toEqual(["completado", "completado", "completado"]);
    });
    expect(portal.maxSimultaneas).toBe(1);
    expect(portal.llamadasBuzon).toBeGreaterThan(0);
    expect(portal.llamadas).toHaveLength(24);
    // Ventanas 202511..202610 y 202510..202609: 11 presentaciones del PDT de prueba (202510 no tiene), cada una una sola vez.
    const ds = await declaracionesDe(admin, m.c.id);
    expect(ds).toHaveLength(11);
    expect(new Set(ds.map((d) => `${d.periodo}:${d.numero_orden}`)).size).toBe(11);
    expect(await obtencionesDe(admin, m.c.id)).toHaveLength(2);
  });
});

// ===========================================================================================================================
describe("300 clientes de un estudio frente a uno de otro (008: reparto por tenant de la cola sol; CA-11)", () => {
  const CLIENTES = 300;
  it("el trabajo del otro estudio, encolado al final, termina antes de que el estudio grande vacíe la mitad de su cola", async () => {
    // El cupo por tenant es a lo sumo la mitad del global (CHECK de config_sistema): A no puede ocupar todo el global.
    await fijarConfig(admin, "sol", { global: 6, tenant: 3, espera: 0, reintentos: 1, base: 100, maxPendientes: 2000 });
    const A = await e.estudio();
    const uA = await e.usuario(A, "contador");
    const secretos = { usuario: canario("usuario_sol"), clave: canario("clave_sol") };
    const clientesA: { id: string; ruc: string }[] = [];
    for (let i = 0; i < CLIENTES; i += 25) {
      const tanda = await Promise.all(
        Array.from({ length: Math.min(25, CLIENTES - i) }, async () => {
          const c = await e.cliente(A);
          await asignarResponsable(admin, A, c.id, uA);
          await guardarCredencial(backend, A, c.id, "sol", secretos);
          return c;
        }),
      );
      clientesA.push(...tanda);
    }
    const b = await mundo();
    const portal = new PortalPdt().todos(pdtDoce());
    portal.demoraMs = 3;
    let terminadosAAlFinDeB = -1;
    await conWorker(portal, async () => {
      for (let i = 0; i < clientesA.length; i += 25)
        await Promise.all(
          clientesA.slice(i, i + 25).map((c) => encolarDeclaraciones(backend, redis, prefijo, { T: A, u: uA, c })),
        );
      const jb = await encolarDeclaraciones(backend, redis, prefijo, b);
      expect((await esperarTerminal(e, jb.id, 120_000)).estado).toBe("completado");
      const r = await admin.pool.query(
        `select count(*)::int as n from job_registro
          where tenant_id = $1 and tipo = 'sol.declaraciones.descargar' and estado in ('completado', 'error', 'cancelado')`,
        [A],
      );
      terminadosAAlFinDeB = r.rows[0].n as number;
      await esperarHasta(
        async () => {
          const q = await admin.pool.query(
            `select count(*)::int as n from job_registro
              where tenant_id = $1 and tipo = 'sol.declaraciones.descargar' and estado in ('completado', 'error', 'cancelado')`,
            [A],
          );
          return q.rows[0].n === CLIENTES;
        },
        "los 300 de A terminan",
        { timeoutMs: 240_000, cadenciaMs: 250 },
      );
    });
    expect(terminadosAAlFinDeB, "trabajos de A terminados cuando terminó el de B").toBeLessThan(CLIENTES / 2);
    expect(await obtencionesDe(admin, b.c.id)).toHaveLength(1);
  });
});

// ===========================================================================================================================
describe("permisos con el trabajo en cola: desasignado, degradado o desactivado antes de despachar (008 D17; D-5, CA-9)", () => {
  it("los tres se cancelan con acceso_retirado sin llamar a SOL ni escribir; el control del mismo estudio termina", async () => {
    await fijarConfig(admin, "sol", { global: 6, tenant: 3, espera: 0, reintentos: 1, base: 100 });
    const base = await mundo();
    const otro = async (): Promise<MundoProrrata> => {
      const u = await e.usuario(base.T, "contador");
      return mundoProrrata(e, admin, backend, { T: base.T, u });
    };
    const [desasignado, degradado, desactivado] = [await otro(), await otro(), await otro()];
    const portal = new PortalPdt().todos(pdtDoce());
    const ids = {
      control: (await encolarDeclaraciones(backend, redis, prefijo, base)).id,
      desasignado: (await encolarDeclaraciones(backend, redis, prefijo, desasignado)).id,
      degradado: (await encolarDeclaraciones(backend, redis, prefijo, degradado)).id,
      desactivado: (await encolarDeclaraciones(backend, redis, prefijo, desactivado)).id,
    };
    // Cambios de acceso con los trabajos ya en cola (antes de que el worker arranque).
    await admin.pool.query("delete from asignacion where cliente_id = $1 and usuario_id = $2", [desasignado.c.id, desasignado.u]);
    await admin.pool.query("update membresia set rol = 'asistente' where tenant_id = $1 and usuario_id = $2", [base.T, degradado.u]);
    await admin.pool.query("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [base.T, desactivado.u]);
    const fin: Record<string, string> = {};
    await conWorker(portal, async () => {
      for (const [k, id] of Object.entries(ids)) {
        const f = await esperarTerminal(e, id, 60_000);
        fin[k] = `${f.estado}/${(f as { motivo?: string | null }).motivo ?? ""}`;
      }
    });
    expect(fin).toEqual({
      control: "completado/",
      desasignado: "cancelado/acceso_retirado",
      degradado: "cancelado/acceso_retirado",
      desactivado: "cancelado/acceso_retirado",
    });
    for (const m of [desasignado, degradado, desactivado]) {
      expect(portal.periodos(m.c.ruc)).toEqual([]);
      expect(await obtencionesDe(admin, m.c.id)).toHaveLength(0);
    }
    expect(await obtencionesDe(admin, base.c.id)).toHaveLength(1);
  });
});
