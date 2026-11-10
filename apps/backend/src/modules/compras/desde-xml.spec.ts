// Spec 016, T17a · `datosDeXml` y `montosParaDestino` (HU-18, D-8, P-9): del `DetalleXml` a los campos de la compra. Puro.
import type { DetalleXml } from "@contapp/domain";
import { describe, expect, it } from "vitest";
import { datosDeXml, montosParaDestino } from "./desde-xml.js";

const RUC = "20700000045";

/** La mixta F001-2056: gravado 8.97 + IGV 1.61 y no gravado 12.51 (valor 21.48). */
function detalle(razonSocial: string): DetalleXml {
  return {
    raiz: "Invoice",
    identidad: {
      tipo: "01",
      serie: "F001",
      numero: "2056",
      emisor: { ruc: RUC, razonSocial },
      receptor: { tipoDoc: "6", numero: "20700000002" },
    },
    fecha: "2026-10-05",
    moneda: "PEN",
    monedaUnica: true,
    totales: {
      gravado: "8.97",
      igv: "1.61",
      noGravado: "12.51",
      isc: "0.00",
      icbper: "0.00",
      otros: "0.00",
      total: "23.09",
    },
    items: [],
  };
}

describe("datosDeXml", () => {
  it("copia la identidad, la fecha, la moneda y los montos como cadenas (sin tocar los decimales)", () => {
    expect(datosDeXml(detalle("PRUEBA PROVEEDOR MIXTO S.A.C."))).toEqual({
      tipo: "01",
      serie: "F001",
      numero: "2056",
      proveedor: { tipo: "6", numero: RUC, razonSocial: "PRUEBA PROVEEDOR MIXTO S.A.C." },
      fecha: "2026-10-05",
      moneda: "PEN",
      gravado: "8.97",
      igv: "1.61",
      fijos: { noGravado: "12.51", isc: "0.00", icbper: "0.00", otrosTributos: "0.00" },
    });
  });

  it.each([
    ["vacía", ""],
    ["solo espacios", "   \t  "],
    ["solo caracteres de control", "\u0000\u0007\n\r"],
  ])("razón social %s: queda «RUC <ruc>»", (_n, texto) => {
    expect(datosDeXml(detalle(texto)).proveedor.razonSocial).toBe(`RUC ${RUC}`);
  });

  it("la razón social se pasa a una línea: sin controles ni espacios repetidos, y recortada", () => {
    expect(datosDeXml(detalle("  ACME\u0000\n\n  S.A.C.\t")).proveedor.razonSocial).toBe("ACME S.A.C.");
  });

  it("la razón social se recorta a 100 caracteres y no termina en espacio", () => {
    const larga = `${"A".repeat(99)} ${"B".repeat(50)}`;
    const r = datosDeXml(detalle(larga)).proveedor.razonSocial;
    expect(r).toBe("A".repeat(99));
    expect(r.length).toBeLessThanOrEqual(100);
    expect(datosDeXml(detalle("Ñ".repeat(500))).proveedor.razonSocial).toHaveLength(100);
  });
});

describe("montosParaDestino", () => {
  const datos = datosDeXml(detalle("X"));

  it.each([
    ["DG", { biDg: "8.97", igvDg: "1.61" }],
    ["DGNG", { biDgng: "8.97", igvDgng: "1.61" }],
    ["DNG", { biDng: "8.97", igvDng: "1.61" }],
  ] as const)("destino %s: la BI y el IGV del XML van solo a su par; las demás columnas no dependen del destino", (destino, par) => {
    expect(montosParaDestino(datos, destino)).toEqual({
      ...par,
      noGravado: "12.51",
      isc: "0.00",
      icbper: "0.00",
      otrosTributos: "0.00",
    });
  });
});
