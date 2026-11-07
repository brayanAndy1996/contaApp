import { describe, expect, it } from "vitest";
import * as ventas from "./index.js";
import {
  MOTIVOS_ADVERTENCIA_VENTA,
  filaVistaPreviaVentasSchema,
  vistaPreviaVentasSchema,
} from "./esquemas.js";

// Spec 013 · T20a (rojo), decisión D22 del usuario (2026-11-07, defecto D-2 de T20): la vista previa de la importación
// separa las ADVERTENCIAS de los ERRORES. Una fila legible pero descuadrada o en USD sin tipo de cambio es VÁLIDA, lleva
// una advertencia que no bloquea y se guarda tal cual (D3). Contrato de `shared`:
//  - MOTIVOS_ADVERTENCIA_VENTA = ["descuadre", "tipo_cambio_requerido"] (los mismos códigos que ya existen como
//    motivos de fila; aquí son advertencias aparte, con lista cerrada propia). Se exporta del paquete.
//  - filaVistaPreviaVentasSchema: { n, estado, motivos, advertencias: Advertencia[] } con `advertencias` OBLIGATORIA
//    (vacía si no hay); solo admite los dos códigos y nunca texto libre ni el contenido de una celda.
//  - vistaPreviaVentasSchema: suma `conAdvertencia` (entero >= 0): cuántas filas traen alguna advertencia.
//    Una fila con advertencia cuenta también en `validas`; `conError` no la incluye.
//  - Las claves desconocidas se descartan, como antes.

const FILA = { n: 3, estado: "valida", motivos: [], advertencias: ["descuadre"] };

describe("MOTIVOS_ADVERTENCIA_VENTA", () => {
  it("son exactamente `descuadre` y `tipo_cambio_requerido`, en ese orden", () => {
    expect([...MOTIVOS_ADVERTENCIA_VENTA]).toEqual(["descuadre", "tipo_cambio_requerido"]);
  });

  it("se exporta desde el índice del módulo de ventas", () => {
    expect((ventas as Record<string, unknown>)["MOTIVOS_ADVERTENCIA_VENTA"]).toEqual(MOTIVOS_ADVERTENCIA_VENTA);
  });
});

describe("filaVistaPreviaVentasSchema · advertencias", () => {
  it.each([
    [[]],
    [["descuadre"]],
    [["tipo_cambio_requerido"]],
    [["descuadre", "tipo_cambio_requerido"]],
  ])("acepta una fila válida con advertencias %j y la devuelve igual", (advertencias) => {
    const fila = { n: 2, estado: "valida", motivos: [], advertencias };
    const r = filaVistaPreviaVentasSchema.safeParse(fila);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(fila);
  });

  it("`advertencias` es obligatoria", () => {
    expect(filaVistaPreviaVentasSchema.safeParse({ n: 2, estado: "valida", motivos: [] }).success).toBe(false);
  });

  it.each([
    ["un error de fila que no es advertencia", ["monto_invalido"]],
    ["celda_peligrosa", ["celda_peligrosa"]],
    ["texto libre", ["El total no cuadra"]],
    ["vacío", [""]],
    ["un número", [1]],
    ["null", [null]],
    ["no es una lista", "descuadre"],
    ["null en vez de lista", null],
  ])("rechaza %s como advertencia", (_c, advertencias) => {
    expect(filaVistaPreviaVentasSchema.safeParse({ ...FILA, advertencias }).success).toBe(false);
  });

  it("no deja pasar el contenido de una celda ni el monto descuadrado", () => {
    const r = filaVistaPreviaVentasSchema.safeParse({
      ...FILA,
      total: "999.00",
      valor: "CANARIO-IMP",
      esperado: "118.00",
    });
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.data)).not.toMatch(/999|CANARIO|118/);
    expect(r.data).toEqual(FILA);
  });
});

describe("vistaPreviaVentasSchema · conAdvertencia", () => {
  const vista = {
    filas: [
      { n: 2, estado: "valida", motivos: [], advertencias: [] },
      FILA,
      { n: 4, estado: "valida", motivos: [], advertencias: ["tipo_cambio_requerido"] },
      { n: 5, estado: "error", motivos: ["fecha_invalida"], advertencias: [] },
    ],
    validas: 3,
    conError: 1,
    conAdvertencia: 2,
  };

  it("acepta una vista previa con advertencias y errores, y la devuelve igual", () => {
    const r = vistaPreviaVentasSchema.safeParse(vista);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(vista);
  });

  it("`conAdvertencia` es obligatorio y entero >= 0", () => {
    const sin: Record<string, unknown> = { ...vista };
    delete sin["conAdvertencia"];
    expect(vistaPreviaVentasSchema.safeParse(sin).success).toBe(false);
    for (const v of [-1, 1.5, "2", null, NaN]) {
      expect(vistaPreviaVentasSchema.safeParse({ ...vista, conAdvertencia: v }).success, String(v)).toBe(false);
    }
    expect(vistaPreviaVentasSchema.safeParse({ ...vista, conAdvertencia: 0 }).success).toBe(true);
  });

  it("una fila con advertencia no cuenta como error: el contrato deja `validas` y `conError` aparte", () => {
    const r = vistaPreviaVentasSchema.safeParse(vista);
    expect(r.data?.filas.filter((f) => f.estado === "error")).toHaveLength(r.data?.conError ?? -1);
    expect(r.data?.filas.filter((f) => f.advertencias.length > 0)).toHaveLength(r.data?.conAdvertencia ?? -1);
  });
});
