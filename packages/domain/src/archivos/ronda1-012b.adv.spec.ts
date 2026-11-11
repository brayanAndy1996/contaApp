// Spec 012b · T17 ronda adversarial 1 (adversario, caja negra). TXT de ventas con texto hostil en los campos que vienen de la
// fila (serie, número, tipo y número de documento de la contraparte) y montos en el borde de NUMERIC(14,2). Las pruebas de T1
// cubren la razón social de compras; aquí se ataca ventas, que no tiene razón social pero sí texto del SIRE (013 D3: la venta
// llega como el SIRE la manda). Invariante: si `prepararArchivo` dice «apto», el TXT tiene una línea por venta no excluida, con
// exactamente 17 campos y sin saltos dentro; si no, la venta trae su error con `filaId` y `erroresDeFilaVenta` la hace excluible.
import { describe, expect, it } from "vitest";
import { erroresDeFilaVenta, generarTxt, prepararArchivo } from "../index";
import type { FilaReemplazoVenta } from "../index";
import { lineasCrlf } from "../../tests/ayudas/filas-reemplazo";
import { CABECERA_VENTAS, comoExcluida, ventaNum } from "../../tests/ayudas/filas-venta";

const PROV = { permitirProvisional: true } as const;
const CAMPOS_RVIE = 17;
const preparar = (vigente: FilaReemplazoVenta[]) =>
  prepararArchivo({
    libro: "ventas",
    cabecera: CABECERA_VENTAS,
    original: vigente.filter((f) => f.estado !== "agregada").map((f) => ({ ...f, estado: "original" as const })),
    vigente,
    saltos: [],
    permitirProvisional: true,
  });

const factura = (over: Parameters<typeof ventaNum>[3] = {}) =>
  ventaNum("01", "F001", "10", { contraparte: { tipo: "6", numero: "20700000011" }, ...over });

const HOSTILES = ["|", "\n", "\r", "\u2028", "\u0085", "\u00a0", "\u{1F600}", "\t", "\u0000", "a|b|c|d"];

describe("ADV-012b-d · texto hostil del SIRE en ventas nunca rompe la línea del TXT", () => {
  const casos: [string, (h: string) => FilaReemplazoVenta][] = [
    ["serie", (h) => factura({ comprobante: { tipo: "01", serie: `F0${h}1`, numero: "10" } })],
    ["número", (h) => factura({ comprobante: { tipo: "01", serie: "F001", numero: `1${h}0` } })],
    ["documento de la contraparte", (h) => factura({ contraparte: { tipo: "6", numero: `2070000001${h}` } })],
    ["documento del consumidor final", (h) => ventaNum("03", "B001", "290", { contraparte: { numero: `-${h}` } })],
    ["tipo de documento", (h) => factura({ contraparte: { tipo: `6${h}`, numero: "20700000011" } })],
    ["tipo de comprobante", (h) => factura({ comprobante: { tipo: `0${h}`, serie: "F001", numero: "10" } })],
  ];
  it.each(casos)("%s: o es error excluible de su fila, o la línea queda con 17 campos", (_campo, armar) => {
    const limpia = ventaNum("03", "B001", "1", { fechaEmision: "2026-10-02" });
    for (const h of HOSTILES) {
      const hostil = armar(h);
      const p = preparar([limpia, hostil]);
      if (p.resultado.apto) {
        const lineas = lineasCrlf(generarTxt([limpia, hostil], CABECERA_VENTAS, PROV).bytes);
        expect(lineas, JSON.stringify(h)).toHaveLength(2);
        for (const l of lineas) expect(l.split("|"), JSON.stringify(h)).toHaveLength(CAMPOS_RVIE);
      } else {
        expect(p.resultado.errores.some((e) => e.filaId === hostil.id), JSON.stringify(h)).toBe(true);
        expect(erroresDeFilaVenta(CABECERA_VENTAS, hostil).length, `excluible con ${JSON.stringify(h)}`).toBeGreaterThan(0);
        // Excluida no se prevalida ni sale en el TXT: el periodo genera con la otra venta.
        const sin = preparar([limpia, comoExcluida(hostil)]);
        expect(sin.resultado.apto, JSON.stringify(h)).toBe(true);
        const lineas = lineasCrlf(generarTxt([limpia, comoExcluida(hostil)], CABECERA_VENTAS, PROV).bytes);
        expect(lineas, JSON.stringify(h)).toHaveLength(1);
        expect(lineas[0]?.split("|"), JSON.stringify(h)).toHaveLength(CAMPOS_RVIE);
      }
    }
  });

  it("montos en el borde de NUMERIC(14,2) (factura y nota de crédito) son aptos y salen tal cual", () => {
    const f =ventaNum("01", "F001", "11", {
      contraparte: { tipo: "6", numero: "20700000011" },
      montos: { baseGravada: "847457627118.64", igv: "152542372881.35" },
    });
    const nc = ventaNum("07", "F001", "12", {
      contraparte: { tipo: "6", numero: "20700000011" },
      montos: { baseGravada: "-847457627118.64", igv: "-152542372881.35" },
    });
    const p = preparar([f, nc]);
    expect(p.resultado.errores).toEqual([]);
    const lineas = lineasCrlf(generarTxt([f, nc], CABECERA_VENTAS, PROV).bytes);
    expect(lineas.map((l) => l.split("|").slice(9, 11).concat(l.split("|")[16] ?? ""))).toEqual([
      ["847457627118.64", "152542372881.35", "999999999999.99"],
      ["-847457627118.64", "-152542372881.35", "-999999999999.99"],
    ]);
    expect(p.resumen.impactoIgv.total.toString()).toBe("0.00");
  });
});
