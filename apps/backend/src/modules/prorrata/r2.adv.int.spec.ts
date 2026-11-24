/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 026 · T18 (adversario, ronda 2) de las rutas de la prorrata contra la BD real: sumas del SIRE fuera de NUMERIC(14,2), motivo con
// separadores de línea Unicode, USD sin tipo de cambio en un M declarado (IGV estimado) y precedencia por número de orden numérico.
// Caja blanca: `leerTotalesVentasProrrata` suma las PEN en SQL (NUMERIC sin tope) y `resolverMes` las pasa por `Money.desde`, que con más
// de 12 enteros lanza MontoInvalidoError (no MontoFueraDeRangoError, el único que `lectura.service.ts` convierte en 422);
// `motivoProrrataSchema` y el CHECK de 0065 solo excluyen \p{Cc} y los bidi (no U+2028/U+2029); `igvDeVentas` usa `resumirVentas` y
// descarta su aviso `usd_sin_tipo_cambio`, y el mes M declarado no lleva los avisos del SIRE.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoProrrata,
  declaracionesCA1,
  facturaVenta,
  fila,
  M,
  montosCompra,
  rutaManual,
  rutaUsada,
  rutaVentasPeriodo,
  rutaVista,
  ventaNoGravada,
  type Actor,
  type BancoProrrata,
  type DeclSpec,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoProrrata;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoProrrata();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (): Promise<Cliente> => v.cliente(E, { responsable: contador.id });
const u = (): string => E.titular.id;
const ver = (c: { id: string }, periodo = M) => v.http(contador, "GET", rutaVista(c.id, periodo));
const mesDe = (body: any, periodo: string): any => (body?.ventana ?? []).find((m: any) => m.periodo === periodo);

describe("R-2 · un mes SIRE cuya suma PEN no cabe en NUMERIC(14,2)", () => {
  it("dos ventas exoneradas de 600.000.000.000,00 en un mes SIRE: la lectura no responde 500 (igual que la suma de manuales: 422 o 200)", async () => {
    const c = await nuevoCliente();
    // 11 meses manuales normales y 202601 solo con ventas del SIRE: cada venta cabe en NUMERIC(14,2), su suma (1,2 billones) no.
    for (const periodo of ["202511", "202512", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609", "202610"]) {
      await v.sembrarManual(E.tenantId, c.id, { periodo, gravadas: "1000.00", exportaciones: "0.00", noGravadas: "0.00", autor: u() });
    }
    await v.sembrarVentasSire(
      E.tenantId,
      c.id,
      "202601",
      [ventaNoGravada("E001", 1, { exonerada: "600000000000.00" }), ventaNoGravada("E001", 2, { exonerada: "600000000000.00" })],
      u(),
    );
    const r = await ver(c);
    expect(r.status, r.text).not.toBe(500);
    expect([200, 422], r.text).toContain(r.status);
    expect(r.text).not.toContain("600000000000");
  });
});

describe("motivo del manual: «sin controles» también para los separadores de línea Unicode", () => {
  it.each([
    ["U+2028 LINE SEPARATOR", "Libro de ventas físico"],
    ["U+2029 PARAGRAPH SEPARATOR", "Libro de ventas físico"],
  ])("%s en medio del motivo: 400 solicitud_invalida y nada guardado", async (_n, motivo) => {
    const c = await nuevoCliente();
    const r = await v.http(contador, "PUT", rutaManual(c.id, "202601"), {
      gravadas: "100.00",
      exportaciones: "0.00",
      noGravadas: "0.00",
      motivo,
      version: 0,
    });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.manualesBd(c.id, "202601")).toHaveLength(0);
  });
});

describe("R-2 / R-7 · USD sin tipo de cambio en las ventas de un M declarado", () => {
  it("el IGV estimado no suma la venta USD sin tipo de cambio y la vista lo avisa (como el resumen de 013 y un mes SIRE)", async () => {
    const c = await nuevoCliente();
    await v.sembrarDeclaraciones(E.tenantId, c.id, declaracionesCA1(), { periodoHasta: M });
    await v.sembrarVentasSire(
      E.tenantId,
      c.id,
      M,
      [
        facturaVenta("F001", 1, "10000.00", "1800.00"),
        fila("F002", 1, { tipo: "01", moneda: "USD", baseGravada: "1000.00", igv: "180.00", total: "1180.00" }), // sin tipo de cambio
      ],
      u(),
    );
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { periodo: M, libro: "compras", nuevas: 1, usuarioId: u() });
    await v.sembrarCompra(E.tenantId, c.id, {
      periodo: M,
      serie: "F010",
      numero: "1",
      doc: "20700000011",
      propuestaId,
      usuarioId: u(),
      montos: montosCompra("DG", "1000.00", "180.00"),
    });
    // Control: el resumen de 013 del mismo M avisa la USD que no suma.
    const rv = await v.http(contador, "GET", `${rutaVentasPeriodo(c.id, M)}/resumen`);
    expect(rv.status, rv.text).toBe(200);
    expect(rv.body.avisos).toContain("usd_sin_tipo_cambio");

    const r = await ver(c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.igvEstimado).toMatchObject({ estado: "calculado", igvVentas: "1800.00" });
    const avisosM = JSON.stringify({ mes: mesDe(r.body, M)?.avisos, igv: r.body.igvEstimado });
    expect(avisosM, "el IGV estimado de M deja fuera una venta USD sin decirlo").toContain("usd_sin_tipo_cambio");
  });
});

describe("R-5 / R-8 · vigente por número de orden NUMÉRICO (9 < 10) con la rectificatoria de orden menor presentada después", () => {
  it("montos, `declaracion` y prorrata usada salen de la presentación 10; la 9 (con prorrata) no bloquea ingresar la usada", async () => {
    const c = await nuevoCliente();
    const ds: DeclSpec[] = declaracionesCA1().map((d) => (d.periodo === M ? { ...d, numeroOrden: "10", fecha: "2026-11-05" } : d));
    ds.push({
      periodo: M,
      numeroOrden: "9",
      fecha: "2026-11-20",
      tipo: "rectificatoria",
      gravadas: "999.00",
      noGravadas: "1.00",
      prorrataUsada: "50.00",
    });
    await v.sembrarDeclaraciones(E.tenantId, c.id, ds, { periodoHasta: M });
    const r = await ver(c);
    expect(r.status, r.text).toBe(200);
    expect(mesDe(r.body, M)).toMatchObject({
      origen: "declarado",
      gravadas: "100000.00",
      noGravadas: "20000.00",
      declaracion: { numeroOrden: "10", tipo: "original", presentaciones: 2 },
    });
    expect(r.body.prorrataUsada).toBeNull();
    const w = await v.http(contador, "PUT", rutaUsada(c.id, M), { porcentaje: "87.3", version: 0 });
    expect(w.status, w.text).toBe(200);
    const r2 = await ver(c);
    expect(r2.body.prorrataUsada).toEqual({ valor: "87.30", origen: "ingresada" });
    expect(r2.body.diferencia).toEqual({ diferencia: "3.41", alerta: true }); // 83.89 − 87.30
  });
});
