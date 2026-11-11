// Spec 012b, T20 (ronda adversarial 2): `prepararSinDesborde` (H-012b-2) decide «es desborde» repitiendo `prepararArchivo` con los
// montos en 0.00. Su contrato: «cualquier otro error, incluida una EntradaPrevalidacionInvalidaError de forma, se propaga tal cual».
// Ataque: una forma imposible QUE VIVE EN LOS MONTOS (un valor que no es un Money / MontosComprobante real) desaparece al reconstruir
// los montos en cero, así que la forma se traduce como desborde (422 resumen_fuera_de_rango) en vez de propagarse (500).
import { EntradaPrevalidacionInvalidaError, Money, MontosComprobante, type CabeceraTxt, type FilaReemplazo, type FilaReemplazoVenta } from "@contapp/domain";
import { describe, expect, it } from "vitest";
import { prepararSinDesborde } from "./desborde.js";

class FueraDeRango extends Error {}
const fuera = (): Error => new FueraDeRango();

const CAB: CabeceraTxt = { rucDeclarante: "20100070970", periodo: "202610", libro: "ventas" };
const m = (v: string) => Money.desde(v, "PEN");

/** Imita un Money (misma forma visible) sin serlo: p. ej. uno de otra copia del paquete o armado a mano. */
const moneyFalso = { moneda: "PEN", toString: () => "0.00" } as unknown as Money;

function venta(igv: Money): FilaReemplazoVenta {
  return {
    id: "v1",
    estado: "agregada",
    comprobante: { tipo: "01", serie: "F001", numero: "1" },
    contraparte: { tipo: "6", numero: "20100070970" },
    fechaEmision: "2026-10-05",
    montos: {
      baseGravada: m("100.00"),
      igv,
      exonerada: m("0.00"),
      inafecta: m("0.00"),
      isc: m("0.00"),
      icbper: m("0.00"),
      otros: m("0.00"),
      total: m("118.00"),
    },
    tipoCambio: null,
  };
}

describe("ADV-012b-r2 · desborde: una forma imposible en los montos no es un desborde", () => {
  it("ADV-012b-r2-8: ventas con un monto que no es Money (montos chicos, sin desborde): se propaga la forma, no el 422", () => {
    const e = { libro: "ventas" as const, cabecera: CAB, original: [], vigente: [venta(moneyFalso)], permitirProvisional: true };
    expect(() => prepararSinDesborde(e, fuera)).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("ADV-012b-r2-9: compras con montos que no son MontosComprobante: se propaga la forma, no el 422", () => {
    const real = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const falsos = { moneda: "PEN", total: real.total } as unknown as MontosComprobante;
    const fila: FilaReemplazo = {
      id: "c1",
      estado: "agregada",
      comprobante: { tipo: "01", serie: "F001", numero: "1" },
      proveedor: { tipo: "6", numero: "20100070970" },
      fechaEmision: "2026-10-05",
      montos: falsos,
      tipoCambio: null,
      origenUsd: null,
    };
    const e = { libro: "compras" as const, cabecera: { ...CAB, libro: "compras" as const }, original: [], vigente: [fila], permitirProvisional: true };
    expect(() => prepararSinDesborde(e, fuera)).toThrow(EntradaPrevalidacionInvalidaError);
  });
});
