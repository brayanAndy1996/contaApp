// Spec 013 T17 · ronda adversarial de `analizarCorrelatividad` (D7, D8, D17; CA-6, CA-7).
// Caja negra: la clave de un comprobante (D17) pone la serie en mayúsculas y quita los ceros a la izquierda, así que dos
// filas con la misma clave son el MISMO comprobante para la unicidad (`venta` única por clave, 409 al agregar). La
// correlatividad debe verlas igual: si no, muestra un faltante que el contador no puede cerrar agregando la venta (409) ni
// justificando la serie que ve. Caja blanca: `estadoDelHueco` recorre todas las justificaciones de la serie por cada hueco.
import { describe, expect, it } from "vitest";
import { analizarCorrelatividad, type FilaNumeracion, type Justificado } from "./index";

const f = (serie: string, numero: string, tipo = "03"): FilaNumeracion => ({ tipo, serie, numero });

describe("T17 · correlatividad frente a la clave normalizada (D17)", () => {
  it("adv-c1: B001-290, b001-291 y B001-292 son una sola serie completa (la clave ya las trata como la misma serie)", () => {
    const r = analizarCorrelatividad([f("B001", "290"), f("b001", "291"), f("B001", "292")], []);
    expect(r.series.map((s) => [s.serie.toUpperCase(), s.estado])).toEqual([["B001", "completa"]]);
  });

  it("adv-c2: «0000000291» (10 caracteres, clave 03|B001|291) cuenta como la 291: no hay faltante entre 290 y 292", () => {
    const r = analizarCorrelatividad([f("B001", "290"), f("B001", "0000000291"), f("B001", "292")], []);
    expect(r.series).toHaveLength(1);
    expect(r.series[0]!.faltantes, "la 291 está presente con ceros a la izquierda").toEqual([]);
  });

  it("adv-c3: signos, espacios, dígitos Unicode, decimales y exponentes quedan «no evaluables», sin huecos inventados, sin excepción y sin mutar la entrada congelada", () => {
    const raros = ["+291", "-291", " 291", "291 ", "２９１", "٢٩١", "291.0", "2e2", "0x1F", "", "1_000", "Infinity", "NaN"];
    const filas = Object.freeze([f("B001", "290"), ...raros.map((n) => f("B001", n)), f("B001", "292")].map((x) => Object.freeze(x)));
    const r = analizarCorrelatividad(filas, Object.freeze([]));
    expect(r.series).toHaveLength(1);
    const s = r.series[0]!;
    expect(s.noEvaluables).toBe(raros.length);
    expect(s.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
  });

  it("adv-c4: 20.000 filas con 10.000 huecos y una justificación por hueco se analizan en < 1 s", () => {
    const filas: FilaNumeracion[] = [];
    for (let i = 0; i < 20_000; i++) filas.push(f("B001", String(1 + i * 2)));
    const js: Justificado[] = [];
    for (let i = 0; i < 10_000; i++) js.push({ tipo: "03", serie: "B001", desde: 2 + i * 2, hasta: 2 + i * 2, comentario: "x" });
    const t0 = Date.now();
    const r = analizarCorrelatividad(filas, js);
    const ms = Date.now() - t0;
    expect(r.series[0]!.faltantes.filter((x) => x.estado === "justificado")).toHaveLength(10_000);
    expect(Math.round(ms), "ms de un análisis que corre en cada GET y en cada justificar").toBeLessThan(1_000);
  });
});
