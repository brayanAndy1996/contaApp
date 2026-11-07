// Spec 014 · T18 (adversario, caja blanca): caracteres de control en la razón social que trae el SIRE.
// La razón social es texto no confiable (D-13). PostgreSQL no admite el carácter NUL en un `text` (22021): si `preparar` lo deja
// pasar, la descarga entera falla en el INSERT con un error crudo de la BD en vez de `fila_invalida` (D-3), y el trabajo no se
// clasifica como de datos. Lo correcto es rechazar la fila con `fila_invalida` (ErrorDatos, sin reintento) o limpiar el texto.
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

describe("T18 · razón social del SIRE con caracteres de control", () => {
  it("una razón social con NUL no llega a PostgreSQL: o la fila es fila_invalida (ErrorDatos) o el NUL se quita", () => {
    let preparadas: ReturnType<typeof persistidorCompras.preparar> | undefined;
    let error: unknown;
    try {
      preparadas = persistidorCompras.preparar([fila({ razonSocialContraparte: "ACME\u0000 SAC" })]);
    } catch (e) {
      error = e;
    }
    if (error !== undefined) {
      expect(error).toBeInstanceOf(ErrorPropuesta);
      expect((error as ErrorPropuesta).detalle).toBe("fila_invalida");
      return;
    }
    expect(preparadas?.[0]?.datos.razonSocial ?? "", "el NUL llegaría al INSERT y PostgreSQL respondería 22021").not.toContain(
      "\u0000",
    );
  });
});
