// Spec 026 · T19 (tester; H-026-2-1, en rojo) del trabajo `sol.declaraciones.descargar` con PostgreSQL, Redis y BullMQ reales.
// Decisión (D-3, T18): una presentación que el puerto entrega y la función acotada rechazaría (22023: número de orden 0, el mismo número
// escrito «01» y «1», fecha anterior a 1900) NO es un fallo transitorio: ese periodo queda «sin declaración» y el resto de la ventana se
// registra, sin reintentos ni el motivo `sunat_no_responde`. La prueba fija el resultado observable y no el mecanismo (que la función
// valide antes o que el worker filtre antes de llamar es cosa de T20): SOL se lee 12 veces (una por periodo, sin volver a entrar con la
// clave del cliente), el trabajo termina `completado`, la obtención lista el periodo defectuoso como sin declaración y las presentaciones
// de los otros 11 periodos están guardadas. Se usa `PortalPdt` (no valida) para que el puerto entregue el defecto aunque el mock ya lo
// rechace (H-026-2-2).
import type { ContappDb } from "@contapp/db";
import type { SolPortal } from "@contapp/sunat";
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

/** Doce periodos válidos; `mal` reemplaza las presentaciones de 202608. */
function pdtConDefecto(mal: Decl621[]): Record<string, Decl621[]> {
  const periodos: Record<string, Decl621[]> = {};
  for (const p of VENTANA_12) periodos[p] = [decl(p)];
  periodos["202608"] = mal;
  return periodos;
}

describe("H-026-2-1 · una presentación inválida de un periodo no es transitoria: ese periodo queda «sin declaración» y el resto se registra", () => {
  it.each([
    ["número de orden 0", [decl("202608", { numeroOrden: "0" })]],
    [
      "el mismo número de orden escrito «01» y «1» con montos distintos",
      [decl("202608", { numeroOrden: "01" }), decl("202608", { numeroOrden: "1", ventasGravadasBase: "1.00" })],
    ],
    ["fecha de presentación del año 1899", [decl("202608", { fechaPresentacion: "1899-12-31" })]],
  ])("%s: 12 lecturas de SOL, sin reintentos, completado, 202608 sin declaración y 11 periodos guardados", async (_n, mal) => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtConDefecto(mal));
    const fila = await correr(m, portal);
    const detalle = `estado ${String(fila.estado)}, motivo ${String(fila.motivo)}, intentos ${String(fila.intentos)}, SOL leído ${portal.llamadas.length} veces`;

    // Sin reintentos: no se vuelve a descifrar la clave ni a leer SOL por un defecto determinista de una presentación.
    expect(portal.periodos(m.c.ruc), detalle).toHaveLength(12);
    expect(fila.estado, detalle).toBe("completado");
    expect(fila.motivo ?? null, detalle).not.toBe("sunat_no_responde");

    // D-3: el periodo defectuoso queda sin declaración y el resto se registra.
    const obtenciones = await obtencionesDe(admin, m.c.id);
    expect(obtenciones, detalle).toHaveLength(1);
    expect(obtenciones[0]).toMatchObject({ periodo_hasta: "202610", nuevas: 11 });
    expect(obtenciones[0]!.periodos_leidos).toHaveLength(12);
    expect(obtenciones[0]!.periodos_sin_declaracion).toEqual(["202608"]);
    const ds = await declaracionesDe(admin, m.c.id);
    expect(ds.filter((d) => d.periodo === "202608")).toHaveLength(0);
    expect(ds.map((d) => d.periodo).sort()).toEqual(VENTANA_12.filter((p) => p !== "202608").sort());
    expect(fila.resultado).toMatchObject({ periodosLeidos: 12, sinDeclaracion: 1, nuevas: 11 });
  });

  it("dos periodos defectuosos distintos (orden 0 en 202608 y año 1899 en 202601): ambos sin declaración, 10 guardados, 12 lecturas", async () => {
    const m = await mundo();
    const periodos = pdtConDefecto([decl("202608", { numeroOrden: "0" })]);
    periodos["202601"] = [decl("202601", { fechaPresentacion: "1899-12-31" })];
    const portal = new PortalPdt().pdt(m.c.ruc, periodos);
    const fila = await correr(m, portal);
    const detalle = `estado ${String(fila.estado)}, motivo ${String(fila.motivo)}, SOL leído ${portal.llamadas.length} veces`;
    expect(portal.periodos(m.c.ruc), detalle).toHaveLength(12);
    expect(fila.estado, detalle).toBe("completado");
    const o = await obtencionesDe(admin, m.c.id);
    expect(o, detalle).toHaveLength(1);
    expect([...o[0]!.periodos_sin_declaracion].sort()).toEqual(["202601", "202608"]);
    expect(o[0]).toMatchObject({ nuevas: 10 });
    expect((await declaracionesDe(admin, m.c.id)).map((d) => d.periodo).sort()).toEqual(
      VENTANA_12.filter((p) => p !== "202601" && p !== "202608").sort(),
    );
  });

  it("control: sin defectos el mismo trabajo lee 12 veces y guarda los 12 periodos (nada cambia para el caso normal)", async () => {
    const m = await mundo();
    const portal = new PortalPdt().pdt(m.c.ruc, pdtConDefecto([decl("202608")]));
    const fila = await correr(m, portal);
    expect(fila.estado).toBe("completado");
    expect(portal.periodos(m.c.ruc)).toHaveLength(12);
    const o = await obtencionesDe(admin, m.c.id);
    expect(o[0]).toMatchObject({ nuevas: 12, periodos_sin_declaracion: [] });
  });
});
