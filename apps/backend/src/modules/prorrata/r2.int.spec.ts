/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 026 · T19 (tester; pruebas de las correcciones de la ronda adversarial 2, en rojo) de las rutas de la prorrata contra la BD real.
// Una prueba por hallazgo, escrita contra lo que decidió el usuario (2026-11-22) y no contra el ataque:
//  - H-026-2-3 y H-026-2-4: con los montos de la ventana fuera de NUMERIC(14,2) (un mes SIRE que suma más de lo que cabe, o 12 meses de
//    12 dígitos) la lectura responde 200 (nunca 500 ni el 422 `resumen_fuera_de_rango`): la tabla de 12 meses, el coeficiente
//    `{estado: "no_determinable", motivo: "montos_fuera_de_rango"}` y el IGV estimado `{estado: "no_estimable", motivo: "coeficiente"}`.
//    El cuerpo cumple `prorrataVistaSchema` (la pantalla lo valida con ese esquema y no pinta nada si no lo cumple).
//  - H-026-2-6: con M declarado y ventas USD de M sin tipo de cambio, `igvEstimado.avisos` contiene `ventas_usd_sin_tipo_cambio`
//    (el IGV de ventas sigue sin incluirlas, como el resumen de 013). Sin esa situación no hay aviso (clave ausente o lista vacía:
//    omitirla cuando está vacía mantiene en verde `lectura.int.spec.ts`, que compara el IGV con `toEqual`).
//  - H-026-2-5: el motivo con U+2028 o U+2029 es 400 `solicitud_invalida` en guardar y en eliminar, sin guardar nada.
import { prorrataVistaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoProrrata,
  declaracionesCA1,
  facturaVenta,
  fila,
  M,
  montosCompra,
  rutaEliminar,
  rutaManual,
  rutaVentasPeriodo,
  rutaVista,
  VENTANA_M,
  ventaNoGravada,
  type Actor,
  type BancoProrrata,
  type DeclSpec,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const MAXIMO = "999999999999.99"; // el mayor NUMERIC(14,2) que aceptan la BD, el PDT y el manual por mes y por columna
const FUERA = { estado: "no_determinable", motivo: "montos_fuera_de_rango" };

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

/** El cuerpo de la lectura cumple el contrato `prorrataVistaSchema` (lo que valida la pantalla antes de pintar). */
function cumpleContrato(body: unknown): void {
  const r = prorrataVistaSchema.safeParse(body);
  expect(r.success, r.success ? "" : JSON.stringify(r.error.issues.map((i) => i.path.join(".") + ": " + i.message).slice(0, 5))).toBe(true);
}

/** Lo común de los tres escenarios «fuera de rango»: 200, tabla de 12 meses, coeficiente propio, IGV «no estimable» y nada del 422 viejo. */
function esperarFueraDeRango(r: { status: number; text: string; body: any }): void {
  expect(r.status, r.text).toBe(200);
  expect(r.text).not.toContain("resumen_fuera_de_rango");
  expect(r.body.ventana.map((m: any) => m.periodo)).toEqual([...VENTANA_M]);
  expect(r.body.coeficiente).toEqual(FUERA);
  expect(r.body.igvEstimado).toEqual({ estado: "no_estimable", motivo: "coeficiente" });
  expect(r.body.diferencia).toBeNull();
  cumpleContrato(r.body);
}

describe("H-026-2-4 · 12 meses de 12 dígitos: la ventana suma más de lo que cabe en NUMERIC(14,2)", () => {
  it("12 meses manuales de 999.999.999.999,99: 200 con la tabla; coeficiente «montos_fuera_de_rango» e IGV «no_estimable»", async () => {
    const c = await nuevoCliente();
    for (const periodo of VENTANA_M) {
      await v.sembrarManual(E.tenantId, c.id, { periodo, gravadas: MAXIMO, exportaciones: "0.00", noGravadas: "0.00", autor: u() });
    }
    const r = await ver(c);
    esperarFueraDeRango(r);
    // La tabla muestra cada mes con sus montos tal cual (cada uno cabe en NUMERIC(14,2)).
    expect(r.body.ventana.every((m: any) => m.origen === "manual" && m.gravadas === MAXIMO && m.total === MAXIMO)).toBe(true);
  });

  it("11 PDT gravados y 1 no gravado, todos de 12 dígitos: 200 (no el 422 `resumen_fuera_de_rango`) con los meses declarados", async () => {
    const c = await nuevoCliente();
    const ds: DeclSpec[] = VENTANA_M.map((periodo, i) => ({
      periodo,
      numeroOrden: String(7000 + i),
      gravadas: i === 0 ? "0.00" : MAXIMO,
      igv: "0.00",
      exportaciones: "0.00",
      noGravadas: i === 0 ? MAXIMO : "0.00",
      igvDg: "0.00",
      igvDgng: "0.00",
    }));
    await v.sembrarDeclaraciones(E.tenantId, c.id, ds, { periodoHasta: M });
    const r = await ver(c);
    esperarFueraDeRango(r);
    expect(mesDe(r.body, "202511")).toMatchObject({ origen: "declarado", gravadas: "0.00", noGravadas: MAXIMO });
    expect(mesDe(r.body, M)).toMatchObject({ origen: "declarado", gravadas: MAXIMO });
  });

  it("con una prorrata usada ingresada no hay diferencia que comparar, y las ventas y compras de M cargadas no cambian el motivo", async () => {
    const c = await nuevoCliente();
    for (const periodo of VENTANA_M) {
      await v.sembrarManual(E.tenantId, c.id, { periodo, gravadas: MAXIMO, exportaciones: "0.00", noGravadas: "0.00", autor: u() });
    }
    await v.sembrarUsada(E.tenantId, c.id, { periodo: M, porcentaje: "87.30", autor: u() });
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "10000.00", "1800.00")], u());
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
    const r = await ver(c);
    esperarFueraDeRango(r);
    expect(r.body.prorrataUsada).toEqual({ valor: "87.30", origen: "ingresada" });
  });

  it("control: 12 meses de 80.000.000.000,00 (la ventana cabe): coeficiente calculado, como siempre", async () => {
    const c = await nuevoCliente();
    for (const periodo of VENTANA_M) {
      await v.sembrarManual(E.tenantId, c.id, { periodo, gravadas: "80000000000.00", exportaciones: "0.00", noGravadas: "0.00", autor: u() });
    }
    const r = await ver(c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado", porcentaje: "100.00", numerador: "960000000000.00", total: "960000000000.00" });
    cumpleContrato(r.body);
  });
});

describe("H-026-2-3 · un mes SIRE cuya suma PEN no cabe en NUMERIC(14,2): se trata igual que H-026-2-4", () => {
  it("dos ventas exoneradas de 600.000.000.000,00 en 202601: 200 (no 500 ni 422) con la tabla y el coeficiente «montos_fuera_de_rango»", async () => {
    const c = await nuevoCliente();
    for (const periodo of VENTANA_M.filter((p) => p !== "202601")) {
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
    esperarFueraDeRango(r);
    // El mes con el defecto sigue en la tabla como mes SIRE y los demás meses no se pierden.
    expect(mesDe(r.body, "202601")).toMatchObject({ periodo: "202601", origen: "sire", sireCargado: true });
    expect(mesDe(r.body, "202511")).toMatchObject({ origen: "manual", gravadas: "1000.00" });
    expect(mesDe(r.body, M)).toMatchObject({ origen: "manual", gravadas: "1000.00" });
  });
});

describe("H-026-2-6 · ventas USD de M sin tipo de cambio: el IGV estimado lo avisa", () => {
  /** M declarado (CA-1) con una factura PEN de 1.800,00 de IGV y las `extra` ventas, más una compra DG de M. */
  async function conVentasM(extra: ReturnType<typeof fila>[]): Promise<Cliente> {
    const c = await nuevoCliente();
    await v.sembrarDeclaraciones(E.tenantId, c.id, declaracionesCA1(), { periodoHasta: M });
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "10000.00", "1800.00"), ...extra], u());
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
    return c;
  }

  it("una venta USD sin tipo de cambio: `igvEstimado.avisos` = [ventas_usd_sin_tipo_cambio] y el IGV de ventas no la suma", async () => {
    const c = await conVentasM([fila("F002", 1, { tipo: "01", moneda: "USD", baseGravada: "1000.00", igv: "180.00", total: "1180.00" })]);
    const rv = await v.http(contador, "GET", `${rutaVentasPeriodo(c.id, M)}/resumen`);
    expect(rv.body.avisos).toContain("usd_sin_tipo_cambio"); // control: el resumen de 013 ya lo avisa
    const r = await ver(c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.igvEstimado).toMatchObject({ estado: "calculado", igvVentas: "1800.00" });
    expect(r.body.igvEstimado.avisos).toEqual(["ventas_usd_sin_tipo_cambio"]);
    cumpleContrato(r.body);
  });

  it("varias ventas USD sin tipo de cambio: el aviso sale una sola vez", async () => {
    const usd = (n: number) => fila("F002", n, { tipo: "01", moneda: "USD", baseGravada: "100.00", igv: "18.00", total: "118.00" });
    const c = await conVentasM([usd(1), usd(2), usd(3)]);
    const r = await ver(c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.igvEstimado.avisos).toEqual(["ventas_usd_sin_tipo_cambio"]);
  });

  it("control: una venta USD CON tipo de cambio se incluye y no hay aviso", async () => {
    const c = await conVentasM([facturaVenta("F002", 1, "100.00", "18.00", { moneda: "USD", tipoCambio: "3.700", total: "118.00" })]);
    const r = await ver(c);
    expect(r.status, r.text).toBe(200);
    const rv = await v.http(contador, "GET", `${rutaVentasPeriodo(c.id, M)}/resumen`);
    expect(r.body.igvEstimado.igvVentas).toBe(rv.body.total.igv);
    expect(r.body.igvEstimado.igvVentas).not.toBe("1800.00");
    expect(r.body.igvEstimado.avisos ?? []).toEqual([]);
  });

  it("control: sin ventas USD no hay aviso", async () => {
    const c = await conVentasM([]);
    const r = await ver(c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.igvEstimado).toMatchObject({ estado: "calculado", igvVentas: "1800.00" });
    expect(r.body.igvEstimado.avisos ?? []).toEqual([]);
  });
});

describe("H-026-2-5 · el motivo no admite separadores de línea Unicode", () => {
  const SEPARADORES = [
    ["U+2028 LINE SEPARATOR", "Libro de ventas\u2028físico"],
    ["U+2029 PARAGRAPH SEPARATOR", "Libro de ventas\u2029físico"],
  ] as const;

  it.each(SEPARADORES)("PUT …/meses/:periodo con %s: 400 solicitud_invalida y nada guardado", async (_n, motivo) => {
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

  it.each(SEPARADORES)("POST …/meses/:periodo/eliminar con %s: 400 solicitud_invalida y el mes sigue vivo", async (_n, motivo) => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202601", gravadas: "100.00", exportaciones: "0.00", noGravadas: "0.00", autor: u() });
    const r = await v.http(contador, "POST", rutaEliminar(c.id, "202601"), { motivo, version: 1 });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    const filas = await v.manualesBd(c.id, "202601");
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ version: 1, accion: "guardado" });
  });

  it("control: un motivo ordinario con tildes y signos se guarda", async () => {
    const c = await nuevoCliente();
    const r = await v.http(contador, "PUT", rutaManual(c.id, "202601"), {
      gravadas: "100.00",
      exportaciones: "0.00",
      noGravadas: "0.00",
      motivo: "Libro físico: ventas de la ñapa, mes 01",
      version: 0,
    });
    expect(r.status, r.text).toBe(200);
  });
});
