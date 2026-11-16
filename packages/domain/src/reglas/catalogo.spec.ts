// Catálogo de reglas del motor (spec 021, RF-089, P-8) y RUC aportable (P-10, CA-6). Rojo (T7).
import { describe, expect, it } from "vitest";
import { CATALOGO_REGLAS_MOTOR, esRucAportable } from "./catalogo";
import { ORDEN_REGLAS } from "./tipos";

describe("CATALOGO_REGLAS_MOTOR (RF-089, P-8)", () => {
  it("tiene seis reglas: las cinco de 011 en su orden y R-HIS", () => {
    expect(CATALOGO_REGLAS_MOTOR.map((r) => r.codigo)).toEqual([...ORDEN_REGLAS, "R-HIS"]);
    expect(CATALOGO_REGLAS_MOTOR.map((r) => r.codigo)).toEqual(["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS"]);
  });

  it("cada regla tiene una descripción simple no vacía y distinta", () => {
    for (const r of CATALOGO_REGLAS_MOTOR) {
      expect(typeof r.descripcion).toBe("string");
      expect(r.descripcion.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(CATALOGO_REGLAS_MOTOR.map((r) => r.descripcion)).size).toBe(6);
  });

  it("la prevalidación de 012 no figura: ni como código ni en las descripciones", () => {
    expect(CATALOGO_REGLAS_MOTOR.length).toBeGreaterThan(0);
    for (const r of CATALOGO_REGLAS_MOTOR) {
      expect(r.codigo.toLowerCase()).not.toContain("prevalid");
      expect(r.descripcion.toLowerCase()).not.toMatch(/prevalidaci[oó]n/);
    }
  });

  it("es una constante congelada (no se puede alterar desde fuera)", () => {
    expect(Object.isFrozen(CATALOGO_REGLAS_MOTOR)).toBe(true);
    for (const r of CATALOGO_REGLAS_MOTOR) expect(Object.isFrozen(r)).toBe(true);
  });
});

describe("esRucAportable (P-10)", () => {
  it("RUC (tipo 6) que empieza en 20: sí", () => {
    expect(esRucAportable({ tipo: "6", numero: "20100070970" })).toBe(true);
    expect(esRucAportable({ tipo: "6", numero: "20999999999" })).toBe(true);
  });

  it("RUC de persona natural (6 / 10…): no", () => {
    expect(esRucAportable({ tipo: "6", numero: "10456789012" })).toBe(false);
    expect(esRucAportable({ tipo: "6", numero: "15123456789" })).toBe(false);
  });

  it("DNI (tipo 1), aunque el número empiece en 20: no", () => {
    expect(esRucAportable({ tipo: "1", numero: "20123456" })).toBe(false);
    expect(esRucAportable({ tipo: "1", numero: "10123456" })).toBe(false);
  });

  it("tipo 0 (sin documento) u otros tipos, aunque el número empiece en 20: no", () => {
    expect(esRucAportable({ tipo: "0", numero: "20100070970" })).toBe(false);
    expect(esRucAportable({ tipo: "7", numero: "20100070970" })).toBe(false);
    expect(esRucAportable({ tipo: "A", numero: "20100070970" })).toBe(false);
  });
});
