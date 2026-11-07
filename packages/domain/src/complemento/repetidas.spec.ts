// Spec 013 (T9, D18): comprobantes repetidos dentro de una misma descarga o importación (misma clave).
// Se guarda la primera aparición; las siguientes cuentan como `iguales` si son idénticas a ella y como
// `distintas` si no, de modo que recibidas = nuevas + iguales + distintas. Resuelve la ambigüedad 5 de T3.
import { describe, expect, it } from "vitest";
import { planificarComplemento } from "./index";

type Campos = Record<string, string>;
const venta = (total: string): Campos => ({ fecha: "2026-10-03", moneda: "PEN", total });
const ex = (clave: string, campos: Campos, origen: "sire" | "manual" = "sire") => ({ clave, origen, campos });
const rc = (clave: string, campos: Campos) => ({ clave, campos });

describe("planificarComplemento · repetidas en lo recibido (D18)", () => {
  it("la segunda aparición idéntica a la primera (clave nueva): una nueva y una igual", () => {
    const r = planificarComplemento([], [rc("k", venta("1.00")), rc("k", venta("1.00"))]);
    expect(r).toEqual({ nuevas: ["k"], iguales: 1, distintas: [] });
  });

  it("la segunda aparición distinta de la primera (clave nueva): una nueva y una distinta con origen sire", () => {
    const r = planificarComplemento([], [rc("k", venta("1.00")), rc("k", venta("2.00"))]);
    expect(r.nuevas).toEqual(["k"]);
    expect(r.iguales).toBe(0);
    expect(r.distintas).toEqual([{ clave: "k", origenExistente: "sire", campos: ["total"], valoresSire: { total: "2.00" } }]);
  });

  it("solo la primera aparición cuenta como nueva aunque la clave llegue tres veces", () => {
    const r = planificarComplemento([], [rc("k", venta("1.00")), rc("k", venta("1.00")), rc("k", venta("3.00"))]);
    expect(r.nuevas).toEqual(["k"]);
    expect(r.iguales).toBe(1);
    expect(r.distintas.map((d) => d.valoresSire)).toEqual([{ total: "3.00" }]);
  });

  it("las siguientes se comparan con la PRIMERA, no con la anterior: A, B, A → la tercera es distinta de la segunda pero igual a la primera", () => {
    const r = planificarComplemento([], [rc("k", venta("1.00")), rc("k", venta("2.00")), rc("k", venta("1.00"))]);
    expect(r.nuevas).toEqual(["k"]);
    expect(r.iguales).toBe(1);
    expect(r.distintas).toHaveLength(1);
  });

  it("con la clave ya existente: la primera se compara con la existente y las siguientes con la primera", () => {
    const r = planificarComplemento([ex("k", venta("1.00"), "manual")], [rc("k", venta("2.00")), rc("k", venta("2.00")), rc("k", venta("5.00"))]);
    expect(r.nuevas).toEqual([]);
    // 1.ª (2.00 ≠ existente 1.00): distinta; 2.ª (= 1.ª): igual; 3.ª (5.00 ≠ 1.ª): distinta.
    expect(r.iguales).toBe(1);
    expect(r.distintas.map((d) => [d.origenExistente, d.valoresSire.total])).toEqual([
      ["manual", "2.00"],
      ["manual", "5.00"],
    ]);
  });

  it("los contadores siempre cuadran: recibidas = nuevas + iguales + distintas", () => {
    const recibidas = [rc("a", venta("1.00")), rc("b", venta("1.00")), rc("a", venta("1.00")), rc("a", venta("9.00")), rc("b", venta("1.00"))];
    const r = planificarComplemento([ex("c", venta("1.00"))], recibidas);
    expect(r.nuevas.length + r.iguales + r.distintas.length).toBe(recibidas.length);
  });

  it("es idempotente: aplicar las nuevas (la primera aparición) y repetir da 0 nuevas", () => {
    const recibidas = [rc("k", venta("1.00")), rc("k", venta("2.00"))];
    const r1 = planificarComplemento([], recibidas);
    const despues = [ex("k", recibidas[0]!.campos)];
    const r2 = planificarComplemento(despues, recibidas);
    expect(r1.nuevas).toEqual(["k"]);
    expect(r2.nuevas).toEqual([]);
    expect(r2.iguales).toBe(1);
    expect(r2.distintas.map((d) => d.valoresSire)).toEqual([{ total: "2.00" }]);
  });
});
