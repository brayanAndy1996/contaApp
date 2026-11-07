// Spec 014 T18 · H-014-4 y DU-24 (usuario 2026-11-07; rojo hasta T20): una razón social del SIRE con el carácter NUL (U+0000)
// hace que `preparar` rechace la descarga entera con `fila_invalida` (ErrorPropuesta, ErrorDatos: sin reintento, todo o nada),
// igual que un monto ilegible. No se limpia ni se recorta el NUL. PostgreSQL no admite el NUL en `text` (22021); sin esto la
// descarga fallaba en el INSERT con un error crudo de la BD. Sin BD: el todo o nada contra la BD real lo cubre
// `persistidor-compras.int.spec.ts` («una fila ilegible (razón social con NUL) …»).
import type { FilaPropuestaSire } from "@contapp/sunat";
import { ErrorDatos } from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import { persistidorCompras } from "./compras.js";
import { ErrorPropuesta } from "./errores.js";

const fila = (numero: string, extra: Partial<FilaPropuestaSire> = {}): FilaPropuestaSire => ({
  tipo: "01",
  serie: "F001",
  numero,
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

const detalleDe = (filas: FilaPropuestaSire[]): unknown => {
  try {
    persistidorCompras.preparar(filas);
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorPropuesta);
    expect(e, "es ErrorDatos: no se reintenta").toBeInstanceOf(ErrorDatos);
    return (e as ErrorPropuesta).detalle;
  }
  return "no lanzó";
};

describe("H-014-4 · DU-24: razón social del SIRE con NUL", () => {
  it.each([
    ["al inicio", "\u0000ACME SAC"],
    ["en medio", "ACME\u0000 SAC"],
    ["al final", "ACME SAC\u0000"],
    ["sola", "\u0000"],
    ["pasado el límite de 200 (el recorte no lo esconde)", `${"A".repeat(200)}\u0000`],
  ])("NUL %s: la descarga se rechaza con fila_invalida", (_n, razonSocialContraparte) => {
    expect(detalleDe([fila("1", { razonSocialContraparte })])).toBe("fila_invalida");
  });

  it("todo o nada: una sola fila con NUL entre filas válidas rechaza la descarga entera (ninguna se prepara)", () => {
    const filas = [fila("1"), fila("2", { razonSocialContraparte: "ACME\u0000 SAC" }), fila("3")];
    expect(detalleDe(filas)).toBe("fila_invalida");
  });

  it("el detalle del error no lleva el contenido de la fila", () => {
    let error: unknown;
    try {
      persistidorCompras.preparar([fila("1", { razonSocialContraparte: "SECRETO\u0000 SAC" })]);
    } catch (e) {
      error = e;
    }
    expect(error, "debió lanzar ErrorPropuesta").toBeInstanceOf(ErrorPropuesta);
    expect(JSON.stringify(error)).not.toContain("SECRETO");
    expect((error as Error).message).not.toContain("SECRETO");
  });

  it("caso feliz: una razón social normal (tildes, &, HTML, fórmula) sigue pasando tal cual", () => {
    for (const rs of ["PROVEEDOR SINTETICO S.A.C.", "Peña & Hijos «Perú» S.A.C.", "<b>X</b> =1+1"]) {
      const [p] = persistidorCompras.preparar([fila("1", { razonSocialContraparte: rs })]);
      expect(p?.datos.razonSocial, rs).toBe(rs);
    }
  });

  it("caso feliz: sin razón social (vacía o ausente) sigue siendo null y no es error", () => {
    for (const rs of ["", undefined]) {
      const [p] = persistidorCompras.preparar([fila("1", { razonSocialContraparte: rs as never })]);
      expect(p?.datos.razonSocial).toBeNull();
    }
  });

  it("los demás controles de la razón social del SIRE no se rechazan (DU-24 solo fija el NUL)", () => {
    const [p] = persistidorCompras.preparar([fila("1", { razonSocialContraparte: "ACME\u0007 SAC" })]);
    expect(p?.datos.razonSocial).toBe("ACME\u0007 SAC");
  });
});
