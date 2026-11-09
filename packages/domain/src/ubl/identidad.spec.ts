// Spec 016 · T2 (rojo). `compararIdentidad` (D-3, CA-12): un XML pertenece a una compra si coinciden RUC del emisor, tipo,
// serie y número normalizados, y el receptor es el RUC del cliente. Si no, devuelve solo los CAMPOS que difieren.
// Contrato fijado aquí (el plan lo deja abierto): `compararIdentidad(detalle, { rucCliente, compra })` →
//   `{ ok: true }` | `{ ok: false, campos: ("ruc" | "tipo" | "serie" | "numero" | "receptor")[] }`
// con `compra` = { docTipo, docNumero, tipoDoc, serie, numero } (los nombres de `CompraEvaluable`) y los campos en ese orden.
import { describe, expect, it } from "vitest";
import { RUC_CLIENTE, detalleMixta } from "../../tests/ayudas/ubl";
import { compararIdentidad } from "./index";

const COMPRA = { docTipo: "6", docNumero: "20700000045", tipoDoc: "01", serie: "F001", numero: "2056" };
const comparar = (compra: Partial<typeof COMPRA> = {}, rucCliente = RUC_CLIENTE, detalle = detalleMixta()) =>
  compararIdentidad(detalle, { rucCliente, compra: { ...COMPRA, ...compra } });

describe("compararIdentidad · coincide", () => {
  it("la misma compra: ok", () => {
    expect(comparar()).toEqual({ ok: true });
  });

  it("serie con minúsculas en la compra: ok", () => {
    expect(comparar({ serie: "f001" })).toEqual({ ok: true });
  });

  it("serie con minúsculas en el XML: ok", () => {
    const d = detalleMixta({ identidad: { ...detalleMixta().identidad, serie: "f001" } });
    expect(comparar({}, RUC_CLIENTE, d)).toEqual({ ok: true });
  });

  it("número con ceros a la izquierda en la compra: ok", () => {
    expect(comparar({ numero: "00002056" })).toEqual({ ok: true });
  });

  it("número con ceros a la izquierda en el XML: ok", () => {
    const d = detalleMixta({ identidad: { ...detalleMixta().identidad, numero: "0002056" } });
    expect(comparar({}, RUC_CLIENTE, d)).toEqual({ ok: true });
  });
});

describe("compararIdentidad · difiere (CA-12): solo los campos, ninguno de los valores", () => {
  it("otro RUC de emisor", () => {
    expect(comparar({ docNumero: "20700000053" })).toEqual({ ok: false, campos: ["ruc"] });
  });

  it("otro tipo de comprobante", () => {
    expect(comparar({ tipoDoc: "03" })).toEqual({ ok: false, campos: ["tipo"] });
  });

  it("otra serie", () => {
    expect(comparar({ serie: "F002" })).toEqual({ ok: false, campos: ["serie"] });
  });

  it("otro número (los ceros no cuentan, el valor sí)", () => {
    expect(comparar({ numero: "2057" })).toEqual({ ok: false, campos: ["numero"] });
    expect(comparar({ numero: "020560" })).toEqual({ ok: false, campos: ["numero"] });
  });

  it("otro receptor: el RUC del cliente no es el del XML", () => {
    expect(comparar({}, "20700000011")).toEqual({ ok: false, campos: ["receptor"] });
  });

  it("varios campos a la vez, en el orden ruc, tipo, serie, numero, receptor", () => {
    expect(comparar({ docNumero: "20700000053", serie: "F009", numero: "1" }, "20700000011")).toEqual({
      ok: false,
      campos: ["ruc", "serie", "numero", "receptor"],
    });
  });

  it("el resultado no lleva valores del XML ni de la compra", () => {
    const r = comparar({ docNumero: "20700000053" }, "20700000011");
    const texto = JSON.stringify(r);
    for (const secreto of ["20700000045", "20700000053", "20700000011", "PRUEBA PROVEEDOR MIXTO", "2056"]) {
      expect(texto).not.toContain(secreto);
    }
  });

  it("un receptor que no es RUC (DNI con el mismo número) no cuenta como el cliente", () => {
    const d = detalleMixta({ identidad: { ...detalleMixta().identidad, receptor: { tipoDoc: "1", numero: RUC_CLIENTE } } });
    expect(comparar({}, RUC_CLIENTE, d)).toEqual({ ok: false, campos: ["receptor"] });
  });
});
