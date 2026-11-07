// Spec 013 T18 · pruebas de las correcciones de la ronda adversarial (rojo hasta T19) para `analizarCorrelatividad`.
//  - H-013-7 (D17): la serie se agrupa normalizada (mayúsculas ASCII), como la clave del comprobante; las justificaciones
//    se emparejan con la misma normalización. Solo a-z: ningún otro carácter cambia (sin plegado Unicode ni locale).
//  - H-013-8 (D21, usuario 2026-11-07): los ceros a la izquierda del número se ignoran, igual que en la clave.
import { describe, expect, it } from "vitest";
import { analizarCorrelatividad, type FilaNumeracion, type Justificado } from "./index";

const f = (serie: string, numero: string, tipo = "03"): FilaNumeracion => ({ tipo, serie, numero });
const j = (serie: string, desde: number, hasta: number, tipo = "03"): Justificado => ({
  tipo,
  serie,
  desde,
  hasta,
  comentario: "Boleta anulada",
});

describe("H-013-7 · la serie se agrupa por su forma normalizada (D17)", () => {
  it("«B001» y «b001» son una sola serie, que sale en mayúsculas", () => {
    const r = analizarCorrelatividad([f("B001", "290"), f("b001", "291"), f("B001", "292")], []);
    expect(r.series).toEqual([{ tipo: "03", serie: "B001", estado: "completa", faltantes: [], noEvaluables: 0 }]);
  });

  it("un faltante entre «b001» y «B001» se informa una sola vez, en la serie «B001»", () => {
    const r = analizarCorrelatividad([f("b001", "290"), f("B001", "292"), f("b001", "293")], []);
    expect(r.series).toHaveLength(1);
    expect(r.series[0]).toMatchObject({
      serie: "B001",
      estado: "con_faltantes",
      faltantes: [{ desde: 291, hasta: 291, estado: "pendiente" }],
    });
  });

  it("una justificación con la serie en minúsculas cubre el faltante de «B001», y al revés", () => {
    const filas = [f("B001", "290"), f("B001", "292")];
    for (const serie of ["b001", "B001"]) {
      const r = analizarCorrelatividad(filas, [j(serie, 291, 291)]);
      expect(r.series[0]!.faltantes, `justificación con serie «${serie}»`).toEqual([
        { desde: 291, hasta: 291, estado: "justificado", comentario: "Boleta anulada" },
      ]);
    }
    const r = analizarCorrelatividad([f("b001", "290"), f("b001", "292")], [j("B001", 291, 291)]);
    expect(r.series[0]!.faltantes[0]).toMatchObject({ desde: 291, hasta: 291, estado: "justificado" });
  });

  it("el tipo no se toca y sigue separando series: «03|B001» y «01|B001» no se mezclan", () => {
    const r = analizarCorrelatividad([f("B001", "1", "03"), f("b001", "3", "03"), f("B001", "1", "01"), f("B001", "2", "01")], []);
    expect(r.series.map((s) => [s.tipo, s.serie, s.estado])).toEqual([
      ["01", "B001", "completa"],
      ["03", "B001", "con_faltantes"],
    ]);
  });

  it("solo a-z se pliega: «ı001» (i sin punto) y «I001» siguen siendo series distintas, como en la clave (mayúsculas ASCII)", () => {
    const r = analizarCorrelatividad([f("ı001", "1"), f("I001", "2")], []);
    expect(r.series).toHaveLength(2);
  });

  it("no muta la entrada congelada", () => {
    const filas = Object.freeze([f("b001", "290"), f("B001", "292")].map((x) => Object.freeze(x)));
    const js = Object.freeze([Object.freeze(j("b001", 291, 291))]);
    expect(() => analizarCorrelatividad(filas, js)).not.toThrow();
    expect(filas[0]!.serie).toBe("b001");
  });
});

describe("H-013-8 · los ceros a la izquierda del número se ignoran (D21)", () => {
  it("«0000000291» (10 caracteres) es la 291: cierra el faltante entre 290 y 292", () => {
    const r = analizarCorrelatividad([f("B001", "290"), f("B001", "0000000291"), f("B001", "292")], []);
    expect(r.series[0]).toMatchObject({ estado: "completa", faltantes: [], noEvaluables: 0 });
  });

  it("cualquier cantidad de ceros: «000000000000000291» (18 caracteres) también es la 291", () => {
    const r = analizarCorrelatividad([f("B001", "290"), f("B001", "000000000000000291"), f("B001", "292")], []);
    expect(r.series[0]).toMatchObject({ estado: "completa", faltantes: [], noEvaluables: 0 });
  });

  it("con ceros a la izquierda el hueco se sigue detectando y se informa con el número sin ceros", () => {
    const r = analizarCorrelatividad([f("B001", "0000000290"), f("B001", "0000000293")], []);
    expect(r.series[0]).toMatchObject({
      estado: "con_faltantes",
      faltantes: [{ desde: 291, hasta: 292, estado: "pendiente" }],
      noEvaluables: 0,
    });
  });

  it("la justificación del faltante de unos números escritos con ceros lo cubre", () => {
    const r = analizarCorrelatividad([f("B001", "0000000290"), f("B001", "0000000292")], [j("B001", 291, 291)]);
    expect(r.series[0]!.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "justificado", comentario: "Boleta anulada" }]);
  });

  it("sin ceros que quitar, un número de más de 8 dígitos sigue siendo «no evaluable» (sin hueco inventado)", () => {
    const r = analizarCorrelatividad(
      [f("B001", "290"), f("B001", "123456789"), f("B001", "0123456789"), f("B001", "00000000123456789"), f("B001", "292")],
      [],
    );
    expect(r.series[0]).toMatchObject({
      noEvaluables: 3,
      faltantes: [{ desde: 291, hasta: 291, estado: "pendiente" }],
    });
  });

  it("los signos, espacios y dígitos Unicode no se vuelven evaluables por tener ceros delante", () => {
    const raros = ["+0000291", "-0000291", " 0000291", "０００２９１", "000291.0", "0e291"];
    const r = analizarCorrelatividad([f("B001", "290"), ...raros.map((n) => f("B001", n)), f("B001", "292")], []);
    expect(r.series[0]).toMatchObject({
      noEvaluables: raros.length,
      faltantes: [{ desde: 291, hasta: 291, estado: "pendiente" }],
    });
  });
});
