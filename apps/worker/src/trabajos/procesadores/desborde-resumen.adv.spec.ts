// Spec 012b, T20 (ronda adversarial 2): el gemelo del worker de `prepararSinDesborde` (H-012b-2). Una forma imposible que vive en
// los montos (un valor que no es un Money real) desaparece al repetir el armado con los montos en 0.00 y se traduce como
// `resumen_fuera_de_rango` (ErrorDatos, sin reintento) en vez de propagarse como error de programación.
import { EntradaPrevalidacionInvalidaError, Money, type CabeceraTxt, type FilaReemplazoVenta } from "@contapp/domain";
import { describe, expect, it } from "vitest";
import { prepararSinDesborde } from "./desborde-resumen.js";

class FueraDeRango extends Error {}

describe("ADV-012b-r2 · desborde en el worker", () => {
  it("ADV-012b-r2-10: un monto de venta que no es Money (sin desborde) se propaga como forma, no como resumen_fuera_de_rango", () => {
    const m = (v: string) => Money.desde(v, "PEN");
    const cabecera: CabeceraTxt = { rucDeclarante: "20100070970", periodo: "202610", libro: "ventas" };
    const fila: FilaReemplazoVenta = {
      id: "v1",
      estado: "agregada",
      comprobante: { tipo: "01", serie: "F001", numero: "1" },
      contraparte: { tipo: "6", numero: "20100070970" },
      fechaEmision: "2026-10-05",
      montos: {
        baseGravada: m("100.00"),
        igv: m("18.00"),
        exonerada: m("0.00"),
        inafecta: m("0.00"),
        isc: m("0.00"),
        icbper: m("0.00"),
        otros: { moneda: "PEN" } as unknown as Money,
        total: m("118.00"),
      },
      tipoCambio: null,
    };
    expect(() =>
      prepararSinDesborde({ libro: "ventas", cabecera, original: [], vigente: [fila], permitirProvisional: true }, () => new FueraDeRango()),
    ).toThrow(EntradaPrevalidacionInvalidaError);
  });
});
