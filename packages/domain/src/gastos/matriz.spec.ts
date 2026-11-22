// Spec 027 · T1 (rojo). Matriz giro → categorías permitidas (R-13, D-6; plan, Contratos: domain `matriz.ts` y `categorias.ts`).
import { describe, expect, it } from "vitest";
import { CATEGORIAS_GND, categoriasPermitidas } from "../index";

const lista = (s: ReadonlySet<string>): string[] => [...s].sort();
const SIN_AJUSTE = { permitidas: [] as string[], quitadas: [] as string[] };

describe("CATEGORIAS_GND", () => {
  it("son las 6 categorías de U-3, en el orden del plan (se conservan los códigos de 011)", () => {
    expect([...CATEGORIAS_GND]).toEqual([
      "calzado-ropa",
      "juguetes",
      "entretenimiento",
      "alimentos-personales",
      "cuidado-personal",
      "utiles-escolares",
    ]);
  });
});

describe("categoriasPermitidas · base por sección del CIIU del cliente", () => {
  it.each([
    ["0111", "A", []],
    ["1071", "C (D-6: manufactura sin categorías)", []],
    ["4752", "G (D-6: comercio sin categorías)", []],
    ["4900", "H", []],
    ["5610", "I", ["alimentos-personales"]],
    ["6411", "K", []],
    ["8512", "P", ["juguetes", "utiles-escolares"]],
    ["8610", "Q", ["cuidado-personal"]],
    ["9311", "R", ["alimentos-personales", "entretenimiento", "juguetes"]],
    ["9602", "S", ["cuidado-personal"]],
  ])("%s (sección %s)", (ciiu, _seccion, esperadas) => {
    expect(lista(categoriasPermitidas(ciiu, SIN_AJUSTE))).toEqual([...esperadas].sort());
  });

  it("un restaurante permite alimentos-personales (sección I) y no calzado-ropa", () => {
    const s = categoriasPermitidas("5610", SIN_AJUSTE);
    expect(s.has("alimentos-personales")).toBe(true);
    expect(s.has("calzado-ropa")).toBe(false);
  });
});

describe("categoriasPermitidas · ajuste por cliente (la base ∪ permitidas − quitadas)", () => {
  it("el ajuste permite una categoría que la base no tiene (calzado-ropa a una tienda de ropa, D-6)", () => {
    expect(lista(categoriasPermitidas("4771", { permitidas: ["calzado-ropa"], quitadas: [] }))).toEqual(["calzado-ropa"]);
  });

  it("el ajuste permite en C y G lo que el estudio declara que vende o fabrica", () => {
    expect(categoriasPermitidas("4752", { permitidas: ["juguetes"], quitadas: [] }).has("juguetes")).toBe(true);
    expect(categoriasPermitidas("1410", { permitidas: ["calzado-ropa"], quitadas: [] }).has("calzado-ropa")).toBe(true);
  });

  it("el ajuste quita una categoría de la base (alimentos-personales a un restaurante)", () => {
    expect(lista(categoriasPermitidas("5610", { permitidas: [], quitadas: ["alimentos-personales"] }))).toEqual([]);
  });

  it("permitir y quitar a la vez: el ajuste prevalece y quitar gana (R-13)", () => {
    const s = categoriasPermitidas("5610", { permitidas: ["juguetes"], quitadas: ["juguetes", "alimentos-personales"] });
    expect(lista(s)).toEqual([]);
  });

  it("combina base y permitidas", () => {
    expect(lista(categoriasPermitidas("8610", { permitidas: ["juguetes"], quitadas: [] }))).toEqual(["cuidado-personal", "juguetes"]);
  });
});

describe("categoriasPermitidas · cliente sin CIIU (R-13)", () => {
  it("sin CIIU y sin ajuste: nada está prohibido (las 6 permitidas)", () => {
    expect(lista(categoriasPermitidas(null, SIN_AJUSTE))).toEqual([...CATEGORIAS_GND].sort());
  });

  it("sin CIIU solo cuentan las categorías quitadas por el ajuste", () => {
    expect(lista(categoriasPermitidas(null, { permitidas: [], quitadas: ["calzado-ropa", "juguetes"] }))).toEqual(
      ["alimentos-personales", "cuidado-personal", "entretenimiento", "utiles-escolares"],
    );
  });
});

describe("categoriasPermitidas · la entrada no se muta", () => {
  it("congelar el ajuste no lo rompe y no cambia", () => {
    const ajuste = Object.freeze({ permitidas: Object.freeze(["juguetes"]), quitadas: Object.freeze([]) });
    expect(() => categoriasPermitidas("4752", ajuste as never)).not.toThrow();
    expect(ajuste.permitidas).toEqual(["juguetes"]);
  });
});
