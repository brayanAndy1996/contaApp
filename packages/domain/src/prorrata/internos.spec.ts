// Spec 026 (T8): bordes internos de prorrata/ que las pruebas de T1 no fijan (opacidad del Porcentaje,
// meses falsificados, números de orden y entradas mal formadas).
import { describe, expect, it } from "vitest";
import { pen, presentacion, mesManual, VENTANA_202610 as V } from "../../tests/ayudas/prorrata";
import { calcularProrrata } from "./coeficiente";
import { ProrrataError } from "./errores";
import { resolverMes } from "./meses";
import { Porcentaje, centesimasDe, porcentajeProrrata } from "./porcentaje";

const fuente = (f: Record<string, unknown> = {}) => ({ periodo: "202604", declaraciones: [], manual: null, sire: null, ...f });
const doce = () => V.map((p) => mesManual(p, "10.00", "0.00", "5.00"));

describe("Porcentaje opaco", () => {
  it("se serializa como «NN.NN» y da sus centésimas", () => {
    const p = porcentajeProrrata(pen("1.00"), pen("3.00"));
    expect(JSON.stringify({ p })).toBe('{"p":"33.33"}');
    expect(`${p}`).toBe("33.33");
    expect(centesimasDe(p)).toBe(3333n);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it("no se construye fuera del módulo ni se opera como número", () => {
    const p = porcentajeProrrata(pen("1.00"), pen("2.00"));
    expect(() => +(p as never)).toThrow(TypeError);
    expect(() => new (Porcentaje as unknown as new (c: symbol, t: string) => Porcentaje)(Symbol("Porcentaje"), "1.00")).toThrow(TypeError);
    expect(() => centesimasDe(Object.create(Porcentaje.prototype))).toThrow(ProrrataError);
  });
});

describe("resolverMes: entradas mal formadas", () => {
  it("números de orden con ceros a la izquierda se comparan por su valor", () => {
    const a = presentacion({ numeroOrden: "0010", ventasGravadasBase: "1.00" });
    const b = presentacion({ numeroOrden: "9", ventasGravadasBase: "2.00" });
    expect(String(resolverMes(fuente({ declaraciones: [b, a] })).gravadas)).toBe("1.00");
  });

  it.each<[string, Record<string, unknown>]>([
    ["número de orden vacío", { declaraciones: [presentacion({ numeroOrden: "" })] }],
    ["número de orden de 16 dígitos", { declaraciones: [presentacion({ numeroOrden: "1234567890123456" })] }],
    ["presentación null", { declaraciones: [null] }],
    ["declaraciones no es arreglo", { declaraciones: {} }],
    ["manual undefined", { manual: undefined }],
    ["SIRE sin arreglo USD", { sire: { pen: { baseGravada: "0.00", exonerada: "0.00", inafecta: "0.00" }, usd: null } }],
    ["SIRE sin PEN", { sire: { usd: [] } }],
  ])("%s lanza", (_n, extra) => {
    expect(() => resolverMes(fuente(extra))).toThrow();
  });

  it("la fuente que no es objeto lanza un error de dominio con mensaje fijo", () => {
    expect(() => resolverMes(null as never)).toThrow(ProrrataError);
    expect(() => resolverMes([] as never)).toThrow("Entrada de prorrata inválida.");
  });
});

describe("calcularProrrata: solo 12 meses de resolverMes en orden de la ventana", () => {
  it("acepta la ventana completa", () => {
    expect(calcularProrrata(doce()).estado).toBe("calculado");
  });

  it.each<[string, () => unknown]>([
    ["11 meses", () => doce().slice(1)],
    ["no es arreglo", () => ({ length: 12 })],
    ["mes armado a mano con la misma forma", () => doce().map((m, i) => (i === 3 ? { ...m } : m))],
    ["meses desordenados", () => [...doce()].reverse()],
    ["un periodo repetido", () => doce().map((m, i) => (i === 0 ? doce()[1] : m))],
  ])("%s lanza", (_n, meses) => {
    expect(() => calcularProrrata(meses() as never)).toThrow(ProrrataError);
  });
});
