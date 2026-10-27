import { describe, expect, it } from "vitest";
import {
  alcanceDe,
  puedeGestionar,
  puedeSerResponsable,
  ROLES,
  type Rol,
} from "./index.js";

// Contrato (plan 005): alcanceDe(rol) (D16), puedeGestionar(actor, objetivoActual, rolNuevo) (D8) y
// puedeSerResponsable(rol) (D18). Los roles forman una cadena estricta de permisos
// (dueno > admin > contador > asistente > lectura, verificada en permisos.spec.ts), asi que
// "permisos(x) incluidos en permisos(actor)" equivale a rango(x) <= rango(actor).
const RANGO: Record<Rol, number> = {
  dueno: 4,
  admin: 3,
  contador: 2,
  asistente: 1,
  lectura: 0,
};
const dentro = (actor: Rol, r: Rol | null): boolean =>
  r === null || RANGO[r] <= RANGO[actor];

describe("alcanceDe (D16)", () => {
  it.each([
    ["dueno", "global"],
    ["admin", "global"],
    ["contador", "asignado"],
    ["asistente", "asignado"],
    ["lectura", "asignado"],
  ] as const)("%s -> %s", (rol, alcance) => {
    expect(alcanceDe(rol)).toBe(alcance);
  });
});

describe("puedeSerResponsable (D18): tener sire.clasificar", () => {
  it.each([
    ["dueno", true],
    ["admin", true],
    ["contador", true],
    ["asistente", true],
    ["lectura", false],
  ] as const)("%s -> %s", (rol, esperado) => {
    expect(puedeSerResponsable(rol)).toBe(esperado);
  });
});

describe("puedeGestionar (D8, CA-4)", () => {
  it("el Dueno puede invitar, ascender, degradar y desactivar a cualquiera, incluido otro Dueno", () => {
    for (const objetivo of [...ROLES, null] as const) {
      for (const nuevo of [...ROLES, null] as const) {
        if (objetivo === null && nuevo === null) continue;
        expect(puedeGestionar("dueno", objetivo, nuevo)).toBe(true);
      }
    }
  });

  it("el Administrador no toca a un Dueno: ni cambiarlo, ni desactivarlo", () => {
    for (const nuevo of [...ROLES, null] as const) {
      expect(puedeGestionar("admin", "dueno", nuevo)).toBe(false);
    }
  });

  it("el Administrador no crea ni asciende a nadie a Dueno (invitar o cambiar de rol)", () => {
    expect(puedeGestionar("admin", null, "dueno")).toBe(false);
    for (const objetivo of [
      "admin",
      "contador",
      "asistente",
      "lectura",
    ] as const) {
      expect(puedeGestionar("admin", objetivo, "dueno")).toBe(false);
    }
  });

  it("el Administrador si gestiona a Administrador, Contador, Asistente y Lectura", () => {
    for (const nuevo of [
      "admin",
      "contador",
      "asistente",
      "lectura",
    ] as const) {
      expect(puedeGestionar("admin", null, nuevo)).toBe(true);
      for (const objetivo of [
        "admin",
        "contador",
        "asistente",
        "lectura",
      ] as const) {
        expect(puedeGestionar("admin", objetivo, nuevo)).toBe(true);
      }
    }
    for (const objetivo of [
      "admin",
      "contador",
      "asistente",
      "lectura",
    ] as const) {
      expect(puedeGestionar("admin", objetivo, null)).toBe(true);
    }
  });

  it("nadie otorga un rol con permisos que no tiene (tabla completa de actores x objetivos x roles nuevos)", () => {
    for (const actor of ROLES) {
      for (const objetivo of [...ROLES, null] as const) {
        for (const nuevo of [...ROLES, null] as const) {
          if (objetivo === null && nuevo === null) continue;
          const esperado = dentro(actor, objetivo) && dentro(actor, nuevo);
          expect(
            puedeGestionar(actor, objetivo, nuevo),
            `${actor}: ${objetivo} -> ${nuevo}`,
          ).toBe(esperado);
        }
      }
    }
  });

  it("un Contador no puede subir a nadie a Administrador ni a Dueno, pero si bajar un Asistente a Lectura", () => {
    expect(puedeGestionar("contador", "asistente", "admin")).toBe(false);
    expect(puedeGestionar("contador", "asistente", "dueno")).toBe(false);
    expect(puedeGestionar("contador", "asistente", "lectura")).toBe(true);
    expect(puedeGestionar("contador", "admin", "lectura")).toBe(false);
  });

  it("un Asistente y Lectura solo alcanzan roles iguales o menores", () => {
    expect(puedeGestionar("asistente", null, "contador")).toBe(false);
    expect(puedeGestionar("asistente", "lectura", "asistente")).toBe(true);
    expect(puedeGestionar("lectura", null, "asistente")).toBe(false);
    expect(puedeGestionar("lectura", "lectura", "lectura")).toBe(true);
  });
});
