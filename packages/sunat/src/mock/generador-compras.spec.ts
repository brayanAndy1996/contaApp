import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { igvEsperado, Money, TASA_IGV_18 } from "@contapp/domain";
import { ErrorDatos } from "../errores.js";
import type { FilaPropuestaSire, TokenSire } from "../puertos.js";
import { generarFilasComprasVolumen, MockSireApiClient } from "./sire-api-client.mock.js";

// Spec 014, T7 (CA-1, CA-9, CA-15): razón social de los proveedores de prueba, la fila USD F001-4062 (redondeo)
// y el generador determinista de 5.000 filas de compras. Los RUC salen de `fixtures/rucs-prueba.json`.

const TOKEN: TokenSire = { token: "token-de-prueba", expiraEn: new Date("2026-10-27T16:00:00Z") };
const CONTRIBUYENTE = "20700000002";
const RUCS: Array<{ ruc: string; razonSocial: string }> = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "fixtures", "rucs-prueba.json"), "utf8"),
);

async function comprasDelMock(ruc: string, periodo: string): Promise<FilaPropuestaSire[]> {
  const p = await new MockSireApiClient().descargarPropuesta(TOKEN, { ruc, periodo, libro: "compras" });
  if (p.libro !== "compras") throw new Error("se esperaba la propuesta de compras");
  return p.filas;
}

const dinero = (valor: string, moneda: "PEN" | "USD"): Money => Money.desde(valor, moneda);

describe("fixtures de compras (T7): razón social y redondeo USD", () => {
  it("cada fila del caso de CA-2 trae la razón social de su proveedor en rucs-prueba.json", async () => {
    const filas = await comprasDelMock(CONTRIBUYENTE, "202610");
    expect(filas).toHaveLength(5);
    for (const fila of filas) {
      const proveedor = RUCS.find((r) => r.ruc === fila.rucContraparte);
      expect(fila.razonSocialContraparte, fila.rucContraparte).toBe(proveedor?.razonSocial);
    }
  });

  it("la fila USD F001-4062 (redondeo) da BI 0.15, IGV 0.03, total 0.18 y TC 3.300", async () => {
    const fila = (await comprasDelMock(CONTRIBUYENTE, "202610")).find((f) => f.numero === "4062");
    expect(fila).toMatchObject({ moneda: "USD", tipoCambio: "3.300", biDg: "0.15", igvDg: "0.03", total: "0.18" });
  });

  it("el conjunto genérico de compras trae la razón social de su proveedor", async () => {
    const filas = await comprasDelMock("20100000001", "202611");
    expect(filas.length).toBeGreaterThan(0);
    for (const fila of filas) {
      expect(fila.razonSocialContraparte).toBe("PRUEBA PROVEEDOR GENERICO S.A.C.");
    }
  });
});

describe("generarFilasComprasVolumen (CA-15)", () => {
  const filas = generarFilasComprasVolumen();

  it("da 5.000 filas de compras del periodo pedido, con fechas dentro del mes", () => {
    expect(filas).toHaveLength(5_000);
    for (const f of filas) expect(f.fechaEmision, f.numero).toMatch(/^2026-10-(0[1-9]|1\d|2[0-8])$/);
  });

  it("es determinista: la misma entrada da el mismo arreglo, y una cantidad menor da su prefijo", () => {
    expect(generarFilasComprasVolumen()).toEqual(filas);
    expect(generarFilasComprasVolumen(10)).toEqual(filas.slice(0, 10));
  });

  it("cero filas da una lista vacía", () => {
    expect(generarFilasComprasVolumen(0)).toEqual([]);
  });

  it("tipo, serie y número forman una clave única", () => {
    expect(new Set(filas.map((f) => `${f.tipo}|${f.serie}|${f.numero}`)).size).toBe(5_000);
  });

  it("ningún número de comprobante ni RUC termina en 7, 8 o 9 (centinelas de los mocks)", () => {
    for (const f of filas) {
      expect(f.numero, `número ${f.numero}`).toMatch(/[0-6]$/);
      expect(f.rucContraparte, f.rucContraparte).toMatch(/[0-6]$/);
    }
  });

  it("los RUC son de rucs-prueba.json y ninguno es el contribuyente de prueba", () => {
    const permitidos = new Set(RUCS.map((r) => r.ruc).filter((ruc) => ruc !== CONTRIBUYENTE));
    for (const f of filas) expect(permitidos.has(f.rucContraparte), f.rucContraparte).toBe(true);
  });

  it("cada fila cuadra con Money: IGV = 18 % de su base (010) y total = suma de sus montos", () => {
    for (const f of filas) {
      const m = f.moneda;
      const bi = dinero(f.biDg, m);
      const ng = dinero(f.biDgng, m);
      expect(dinero(f.igvDg, m).igual(igvEsperado(bi, TASA_IGV_18)), f.numero).toBe(true);
      expect(dinero(f.igvDgng, m).igual(igvEsperado(ng, TASA_IGV_18)), f.numero).toBe(true);
      const partes = [
        bi,
        dinero(f.igvDg, m),
        ng,
        dinero(f.igvDgng, m),
        dinero(f.biDng, m),
        dinero(f.igvDng, m),
        dinero(f.noGravado, m),
        dinero(f.isc, m),
        dinero(f.icbper, m),
        dinero(f.otros, m),
      ];
      expect(Money.suma(partes, m).igual(dinero(f.total, m)), f.numero).toBe(true);
    }
  });

  it("los montos son cadenas con dos decimales; solo las filas USD traen tipo de cambio, con tres", () => {
    for (const f of filas) {
      expect(f.total, f.numero).toMatch(/^\d+\.\d{2}$/);
      if (f.moneda === "USD") expect(f.tipoCambio, f.numero).toBe("3.300");
      else expect(f.tipoCambio, f.numero).toBeUndefined();
    }
  });

  it("hay filas de cada forma: gravada, mixta DG + DGNG, con ICBPER y USD", () => {
    expect(filas.some((f) => f.moneda === "USD")).toBe(true);
    expect(filas.some((f) => f.biDgng !== "0.00")).toBe(true);
    expect(filas.some((f) => f.icbper !== "0.00")).toBe(true);
    expect(filas.some((f) => f.moneda === "PEN" && f.biDgng === "0.00" && f.icbper === "0.00")).toBe(true);
  });

  it("un periodo que no es AAAAMM, o una cantidad que no es entera ≥ 0, es ErrorDatos", () => {
    expect(() => generarFilasComprasVolumen(10, "2026-10")).toThrow(ErrorDatos);
    expect(() => generarFilasComprasVolumen(10, "202613")).toThrow(ErrorDatos);
    expect(() => generarFilasComprasVolumen(-1)).toThrow(ErrorDatos);
    expect(() => generarFilasComprasVolumen(1.5)).toThrow(ErrorDatos);
  });
});
