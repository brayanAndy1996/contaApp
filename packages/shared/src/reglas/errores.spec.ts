import { describe, expect, it } from "vitest";
import { CODIGOS_ERROR_REGLA, errorReglaSchema } from "./index.js";

// Spec 021 · T2 (rojo). Códigos de error de las rutas de reglas del cliente (D-5, P-2; plan 021, Contratos: HTTP).
// Contrato fijado por estas pruebas (packages/shared/src/reglas/errores.ts):
//  - CODIGOS_ERROR_REGLA = ["regla_cambiada" (409, versionBase vieja), "proveedores_distintos" (422, «Recordar» con más de un proveedor)].
//    (`cliente_archivado`, 404 y 403 son de las rutas existentes.)
//  - errorReglaSchema = {codigo: uno de ellos}; el cuerpo es solo `{codigo}`: sin datos (D-10), las claves ajenas se descartan.
describe("CODIGOS_ERROR_REGLA", () => {
  it("son regla_cambiada, proveedores_distintos y periodos_distintos (H-021-1-1)", () => {
    expect([...CODIGOS_ERROR_REGLA].sort()).toEqual(["periodos_distintos", "proveedores_distintos", "regla_cambiada"]);
  });
});

describe("errorReglaSchema", () => {
  it.each(["regla_cambiada", "proveedores_distintos", "periodos_distintos"])("acepta {codigo: %s}", (codigo) => {
    expect(errorReglaSchema.parse({ codigo })).toEqual({ codigo });
  });
  it.each(["version_obsoleta", "Regla_cambiada", "regla_cambiada ", "", null, 409, undefined])("rechaza el código %j", (codigo) => {
    expect(errorReglaSchema.safeParse({ codigo }).success).toBe(false);
  });
  it("sin código se rechaza", () => {
    expect(errorReglaSchema.safeParse({}).success).toBe(false);
  });
  it("el cuerpo no filtra datos: descarta ruc, razón social y montos", () => {
    const r = errorReglaSchema.parse({ codigo: "proveedores_distintos", ruc: "20100070970", razonSocial: "PROVEEDOR SAC", total: "118.00" });
    expect(Object.keys(r)).toEqual(["codigo"]);
  });
});
