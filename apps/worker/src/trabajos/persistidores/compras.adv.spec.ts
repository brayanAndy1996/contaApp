// Spec 014 · T18 (adversario, caja blanca): caracteres de control en la razón social que trae el SIRE.
// La razón social es texto no confiable (D-13). PostgreSQL no admite el carácter NUL en un `text` (22021): si `preparar` lo deja
// pasar, la descarga entera falla en el INSERT con un error crudo de la BD en vez de `fila_invalida` (D-3), y el trabajo no se
// clasifica como de datos. Decisión del usuario (DU-24, 2026-11-07): se rechaza con `fila_invalida` (ErrorDatos, sin reintento).
import type { FilaPropuestaSire } from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import { persistidorCompras } from "./compras.js";
import { ErrorPropuesta } from "./errores.js";

const fila = (extra: Partial<FilaPropuestaSire> = {}): FilaPropuestaSire => ({
  tipo: "01",
  serie: "F001",
  numero: "123",
  rucContraparte: "20100070970",
  razonSocialContraparte: "PROVEEDOR SINTETICO S.A.C.",
  fechaEmision: "2026-10-05",
  moneda: "PEN",
  biDg: "100.00",
  igvDg: "18.00",
  biDgng: "0.00",
  igvDgng: "0.00",
  biDng: "0.00",
  igvDng: "0.00",
  noGravado: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
  ...extra,
});

// DU-24 (usuario 2026-11-07): el NUL se rechaza con `fila_invalida`; ya no vale limpiarlo (antes la aserción admitía las dos).
describe("T18 · razón social del SIRE con caracteres de control", () => {
  it("una razón social con NUL no llega a PostgreSQL: la fila es fila_invalida (ErrorDatos), no se limpia (DU-24)", () => {
    let error: unknown;
    try {
      persistidorCompras.preparar([fila({ razonSocialContraparte: "ACME\u0000 SAC" })]);
    } catch (e) {
      error = e;
    }
    expect(error, "el NUL llegaría al INSERT y PostgreSQL respondería 22021").toBeInstanceOf(ErrorPropuesta);
    expect((error as ErrorPropuesta).detalle).toBe("fila_invalida");
  });
});
