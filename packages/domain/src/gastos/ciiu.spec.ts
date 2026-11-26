// Spec 027 · T1 (rojo). CIIU (plan, Contratos: domain `ciiu.ts`; R-3 S2 y S4; R-13). Rev. 4 por división; rubros de S2.
import { describe, expect, it } from "vitest";
import { RUBROS_CONSUMO_PERSONAL, esMinoristaORestaurante, grupoCiiu, seccionCiiu } from "./ciiu";

describe("seccionCiiu · por división (rev. 4)", () => {
  it.each([
    ["0111", "A"], ["0399", "A"], ["0500", "B"], ["0999", "B"], ["1010", "C"], ["3399", "C"], ["3510", "D"], ["3600", "E"],
    ["3999", "E"], ["4100", "F"], ["4399", "F"], ["4500", "G"], ["4752", "G"], ["4799", "G"], ["4900", "H"], ["5399", "H"],
    ["5500", "I"], ["5610", "I"], ["5699", "I"], ["5800", "J"], ["6399", "J"], ["6400", "K"], ["6699", "K"], ["6800", "L"],
    ["6999", "M"], ["7500", "M"], ["7700", "N"], ["8299", "N"], ["8411", "O"], ["8512", "P"], ["8610", "Q"], ["8899", "Q"],
    ["9000", "R"], ["9399", "R"], ["9400", "S"], ["9602", "S"], ["9700", "T"], ["9899", "T"], ["9900", "U"], ["9999", "U"],
  ])("%s → sección %s", (clase, seccion) => {
    expect(seccionCiiu(clase)).toBe(seccion);
  });

  it.each([["0000"], ["0400"], ["3400"], ["4000"], ["4400"], ["4800"], ["5400"], ["5700"], ["6700"], ["7600"], ["8300"], ["8900"]])(
    "%s: división fuera de toda sección → null",
    (clase) => {
      expect(seccionCiiu(clase)).toBeNull();
    },
  );

  it.each([["47a"], ["4"], ["475"], ["47520"], [""], [" 4752"], ["4752 "], ["47a2"], ["０４７５"], ["-475"], ["4.75"]])(
    "%j no es una clase de 4 dígitos → null",
    (clase) => {
      expect(seccionCiiu(clase)).toBeNull();
    },
  );
});

describe("grupoCiiu · 3 dígitos", () => {
  it("devuelve los 3 primeros dígitos de una clase válida", () => {
    expect(grupoCiiu("4752")).toBe("475");
    expect(grupoCiiu("4771")).toBe("477");
    expect(grupoCiiu("0111")).toBe("011");
  });

  it("una clase inválida no tiene grupo", () => {
    expect(grupoCiiu("47a")).toBeNull();
    expect(grupoCiiu("")).toBeNull();
    expect(grupoCiiu("47521")).toBeNull();
  });
});

describe("RUBROS_CONSUMO_PERSONAL · lista base de S2", () => {
  const lista = (): string[] => [...RUBROS_CONSUMO_PERSONAL].sort();

  it("es la lista del plan, exacta", () => {
    expect(lista()).toEqual(
      ["4722", "4723", "4761", "4762", "4763", "4764", "4771", "4772", "5610", "5630", "5914", "9200", "9311", "9321", "9329", "9602"].sort(),
    );
  });

  it("no incluye la ferretería ni el comercio mayorista", () => {
    const l = new Set(lista());
    for (const c of ["4752", "4663", "4711", "4651"]) expect(l.has(c)).toBe(false);
  });
});

describe("esMinoristaORestaurante · S4", () => {
  it.each([["4711"], ["4752"], ["4771"], ["4799"], ["5610"], ["5611"], ["5619"], ["5630"], ["5631"], ["5639"]])("%s → sí", (clase) => {
    expect(esMinoristaORestaurante(clase)).toBe(true);
  });

  it.each([["4663"], ["4610"], ["4651"], ["4899"], ["5620"], ["5629"], ["5510"], ["0111"], ["9602"]])("%s → no", (clase) => {
    expect(esMinoristaORestaurante(clase)).toBe(false);
  });

  it("una clase inválida no es minorista ni restaurante", () => {
    expect(esMinoristaORestaurante("47a")).toBe(false);
    expect(esMinoristaORestaurante("")).toBe(false);
    expect(esMinoristaORestaurante("477")).toBe(false);
  });
});
