// Spec 012b, ronda 1 (H-012b-2): `prepararSinDesborde` traduce SOLO el desborde del impacto en IGV; una forma imposible de la
// entrada (error de programación) se propaga tal cual, aunque también traiga montos enormes.
import {
  EntradaPrevalidacionInvalidaError,
  Money,
  MontosComprobante,
  type CabeceraTxt,
  type FilaReemplazo,
  type FilaReemplazoVenta,
} from "@contapp/domain";
import { describe, expect, it } from "vitest";
import { prepararSinDesborde } from "./desborde-resumen.js";

class FueraDeRango extends Error {}
const fuera = (): Error => new FueraDeRango();

const CAB_VENTAS: CabeceraTxt = { rucDeclarante: "20100070970", periodo: "202610", libro: "ventas" };
const CAB_COMPRAS: CabeceraTxt = { ...CAB_VENTAS, libro: "compras" };

function venta(n: number, base: string, igv: string, total: string, estado: FilaReemplazoVenta["estado"] = "agregada"): FilaReemplazoVenta {
  const m = (v: string) => Money.desde(v, "PEN");
  return {
    id: `01-F001-${n}`,
    estado,
    comprobante: { tipo: "01", serie: "F001", numero: String(n) },
    contraparte: { tipo: "6", numero: "20100070970" },
    fechaEmision: "2026-10-05",
    montos: {
      baseGravada: m(base),
      igv: m(igv),
      exonerada: m("0.00"),
      inafecta: m("0.00"),
      isc: m("0.00"),
      icbper: m("0.00"),
      otros: m("0.00"),
      total: m(total),
    },
    tipoCambio: null,
  };
}

function compra(n: number, bi: string, igv: string, total: string, usd = false): FilaReemplazo {
  return {
    id: `c${n}`,
    estado: "agregada",
    comprobante: { tipo: "01", serie: "F001", numero: String(n) },
    proveedor: { tipo: "6", numero: "20100070970" },
    fechaEmision: "2026-10-05",
    montos: MontosComprobante.desde("PEN", { biDg: bi, igvDg: igv, total }),
    tipoCambio: null,
    origenUsd: usd ? { montos: MontosComprobante.desde("USD", { biDg: "10.00", igvDg: "1.80", total: "11.80" }), tipoCambio: "3.500" } : null,
  };
}

const enormes = <T>(f: (n: number, a: string, b: string, c: string) => T): T[] =>
  Array.from({ length: 7 }, (_, i) => f(i + 1, "800000000000.00", "144000000000.00", "944000000000.00"));

const ventas = (original: FilaReemplazoVenta[], vigente: FilaReemplazoVenta[]) =>
  prepararSinDesborde({ libro: "ventas", cabecera: CAB_VENTAS, original, vigente, permitirProvisional: true }, fuera);
const compras = (vigente: FilaReemplazo[]) =>
  prepararSinDesborde({ libro: "compras", cabecera: CAB_COMPRAS, original: [], vigente, permitirProvisional: true }, fuera);

describe("prepararSinDesborde", () => {
  it("sin desborde devuelve lo mismo que prepararArchivo", () => {
    const p = ventas([], [venta(1, "100.00", "18.00", "118.00")]);
    expect(p.resumen.impactoIgv.total.toString()).toBe("18.00");
    expect(compras([compra(1, "100.00", "18.00", "118.00", true)]).resumen.agregadas).toBe(1);
  });

  it("Σ IGV fuera de NUMERIC(14,2) (ventas y compras, también con origen USD): lanza el error de fuera de rango", () => {
    expect(() => ventas([], enormes(venta))).toThrow(FueraDeRango);
    expect(() => compras([...enormes(compra), compra(8, "100.00", "18.00", "118.00", true)])).toThrow(FueraDeRango);
  });

  it("una forma imposible se propaga tal cual, aunque los montos también desborden", () => {
    // Una agregada con el id de una original: forma imposible del dominio (no depende de los montos).
    const original = [venta(1, "100.00", "18.00", "118.00", "original")];
    const vigente = [...enormes(venta)];
    expect(() => ventas(original, vigente)).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => ventas(original, vigente)).not.toThrow(FueraDeRango);
  });

  it("una entrada que ni siquiera tiene forma se propaga tal cual", () => {
    const nula = null as unknown as Parameters<typeof prepararSinDesborde>[0];
    expect(() => prepararSinDesborde(nula, fuera)).toThrow(EntradaPrevalidacionInvalidaError);
  });
});
