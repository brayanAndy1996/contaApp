// Spec 026 · T18 (adversario, ronda 2) del trabajo `sol.declaraciones.descargar` con PostgreSQL, Redis y BullMQ reales: entradas del PDT
// que el puerto entrega como válidas y la función acotada rechaza. Caja blanca: el procesador pasa las presentaciones del puerto tal cual a
// `registrarDeclaraciones`; `prorrata_declaraciones_registrar` (0067) rechaza con 22023 TODA la obtención si una sola presentación no
// cumple (número de orden 0, el mismo número escrito «01» y «1», año < 1900, monto en notación científica); el `ProrrataRepoError` no es un
// `ErrorSunat`, así que `clasificarError` lo trata como `transitorio`: el ejecutor reintenta y cada intento vuelve a descifrar la clave y
// a leer los 12 periodos de SOL. El `MockSolPortal` (adaptador por omisión) valida con reglas más laxas que la BD (D-2: «defectos =
// ErrorDatos») y deja pasar esas presentaciones.
import type { ContappDb } from "@contapp/db";
import { MockSolPortal, type SolPortal } from "@contapp/sunat";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { arrancar007b, esperarTerminal } from "../../../test/procesadores-007b.js";
import { limpiarFilas017 } from "../../../test/notificaciones.js";
import {
  PortalPdt,
  VENTANA_12,
  declaracionesDe,
  decl,
  encolarDeclaraciones,
  limpiarProrrata,
  mundoProrrata,
  obtencionesDe,
  type Decl621,
  type MundoProrrata,
} from "../../../test/prorrata.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
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

/** Cuenta las llamadas de PDT 621 al portal real (mock) sin cambiar su comportamiento. */
function contando(p: SolPortal): { portal: SolPortal; llamadas: string[] } {
  const llamadas: string[] = [];
  const portal: SolPortal = {
    listarMensajes: (c, o) => p.listarMensajes(c, o),
    obtenerMensaje: (c, id, o) => p.obtenerMensaje(c, id, o),
    obtenerDeclaraciones621: (c, o) => {
      llamadas.push(o.periodo);
      return p.obtenerDeclaraciones621(c, o);
    },
  } as SolPortal;
  return { portal, llamadas };
}

/** Corre un trabajo de 202610 con el portal dado y 2 reintentos permitidos; devuelve la fila final del trabajo. */
async function correr(m: MundoProrrata, portal: SolPortal): Promise<Record<string, unknown>> {
  await fijarConfig(admin, "sol", { global: 4, tenant: 2, espera: 0, reintentos: 2, base: 100 });
  const w = await arrancar007b({ prefijo, solPortal: portal } as Parameters<typeof arrancar007b>[0]);
  try {
    const { id } = await encolarDeclaraciones(backend, redis, prefijo, m, "202610");
    return (await esperarTerminal(e, id, 120_000)) as Record<string, unknown>;
  } finally {
    await w.detener({ esperaMs: 5000 });
  }
}

/** Doce periodos válidos para el mock (`{periodos}`); `mal` reemplaza las presentaciones de 202608. */
function pdtConDefecto(mal: Decl621[]): { periodos: Record<string, Decl621[]> } {
  const periodos: Record<string, Decl621[]> = {};
  for (const p of VENTANA_12) periodos[p] = [decl(p)];
  periodos["202608"] = mal;
  return { periodos };
}

// ===========================================================================================================================
describe("MockSolPortal (adaptador por omisión) entrega presentaciones que la función acotada rechaza (D-2, D-3)", () => {
  it.each([
    ["número de orden 0", [decl("202608", { numeroOrden: "0" })]],
    [
      "el mismo número de orden escrito «01» y «1» con montos distintos",
      [decl("202608", { numeroOrden: "01" }), decl("202608", { numeroOrden: "1", ventasGravadasBase: "1.00" })],
    ],
    ["fecha de presentación del año 1899", [decl("202608", { fechaPresentacion: "1899-12-31" })]],
  ])("%s: o el mock lo rechaza (ErrorDatos) o el trabajo lee SOL una sola vez y termina sin reintentos", async (_n, mal) => {
    const m = await mundo();
    const mock = new MockSolPortal();
    try {
      mock.inyectar(m.c.ruc, pdtConDefecto(mal) as Parameters<MockSolPortal["inyectar"]>[1]);
    } catch {
      return; // el mock valida igual que la BD: correcto
    }
    const { portal, llamadas } = contando(mock);
    const fila = await correr(m, portal);
    // Un rechazo determinista de la BD no es «SUNAT no responde»: no se vuelve a entrar a SOL con la clave del cliente.
    expect(llamadas, `SOL leído ${llamadas.length} veces (motivo ${String(fila.motivo)}, intentos ${String(fila.intentos)})`).toHaveLength(12);
    expect(fila.estado).toBe("completado");
    // Lo que se registró es coherente: el periodo defectuoso no quedó con una presentación inválida y los demás no se perdieron.
    const ds = await declaracionesDe(admin, m.c.id);
    expect(ds.filter((d) => d.periodo === "202608").every((d) => Number(d.numero_orden) > 0)).toBe(true);
    expect(await obtencionesDe(admin, m.c.id)).toHaveLength(1);
  });
});

// ===========================================================================================================================
describe("un adaptador que entrega un monto en notación científica (D-1: montos como cadenas decimales)", () => {
  it("no se reintenta como transitorio ni deja el RUC o el monto en el trabajo", async () => {
    const m = await mundo();
    const datos: Record<string, Decl621[]> = {};
    for (const p of VENTANA_12) datos[p] = [decl(p)];
    datos["202610"] = [decl("202610", { ventasGravadasBase: "7.6543219e6" })];
    const portal = new PortalPdt().pdt(m.c.ruc, datos);
    const fila = await correr(m, portal);
    // D-7: ni el RUC ni montos ni la clave en el `resultado` ni en el motivo (la columna `ruc` de 008 es el bloqueo por RUC, no una traza).
    const texto = JSON.stringify({ resultado: fila.resultado, motivo: fila.motivo });
    expect(texto).not.toContain(m.c.ruc);
    expect(texto).not.toContain("7.6543219e6");
    expect(texto).not.toContain(m.secretos.clave);
    expect(portal.periodos(m.c.ruc), `SOL leído ${portal.llamadas.length} veces (motivo ${String(fila.motivo)})`).toHaveLength(12);
  });
});
