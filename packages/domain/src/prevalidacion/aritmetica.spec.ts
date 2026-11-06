// Spec 012 (T4, rojo): cuadre, IGV y USD de la prevalidación (D1, D11; CA-3, CA-4).
// Contrato fijado por la prueba:
//  - CUADRE: campo "total", `diferencia` = total - suma de componentes (Money de la moneda de la
//    fila), explicación `La suma de componentes ({suma}) no es igual al total ({total}): diferencia {dif}`.
//  - IGV: campo = columna del IGV del destino (igvDg | igvDgng | igvDng), `destino` DG | DGNG | DNG,
//    explicación `{igv} no es 18 % ni 10 % de {bi}`; cuadra si |igv - redondeo(bi x tasa)| <= 0.01 a
//    18 % o a 10 %. Un IGV exactamente 0.00 con base != 0 NO es error IGV (R-ISC lo avisa, CA-1).
//  - USD_SIN_TC / TC_INVALIDO: campo "tipoCambio". CONVERSION_USD: campo "origenUsd".
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MontosComprobante, prevalidar } from "../index";
import type { ErrorPrevalidacion, FilaReemplazo } from "../index";
import { NUM_RUNS, SEMILLA, arbFila, centavosAString, valores } from "../../tests/ayudas/comprobante";
import { CABECERA, ctxBase, filaReemplazo, montosDe } from "../../tests/ayudas/filas-reemplazo";
import type { Columnas } from "../../tests/ayudas/filas-reemplazo";

const errores = (filas: FilaReemplazo[], conReglas = false): readonly ErrorPrevalidacion[] =>
  prevalidar(filas, { cabecera: CABECERA, ...(conReglas ? { reglas: ctxBase() } : {}) }).errores;

/** Fila PEN con total explícito (puede no cuadrar). */
const conTotal = (columnas: Columnas, total: string, over = {}): FilaReemplazo =>
  filaReemplazo(columnas, { montos: MontosComprobante.desde("PEN", { ...columnas, total }), ...over });

describe("CA-3 · cuadre total = Σ componentes (tolerancia 0.00)", () => {
  const COL = { biDg: "100.00", igvDg: "18.00" };

  it("diferencia 0.00 no da error", () => {
    expect(errores([conTotal(COL, "118.00")])).toEqual([]);
  });

  it("total 0.01 mayor que la suma: CUADRE con diferencia 0.01 y la explicación exacta", () => {
    const [e, ...resto] = errores([conTotal(COL, "118.01")]);
    expect(resto).toEqual([]);
    expect(e).toMatchObject({ filaId: "f1", codigo: "CUADRE", campo: "total", destino: null });
    expect(e?.diferencia?.toString()).toBe("0.01");
    expect(e?.diferencia?.moneda).toBe("PEN");
    expect(e?.explicacion).toBe("La suma de componentes (118.00) no es igual al total (118.01): diferencia 0.01");
  });

  it("total 0.01 menor que la suma: diferencia -0.01", () => {
    const [e] = errores([conTotal(COL, "117.99")]);
    expect(e).toMatchObject({ codigo: "CUADRE", campo: "total" });
    expect(e?.diferencia?.toString()).toBe("-0.01");
    expect(e?.explicacion).toBe("La suma de componentes (118.00) no es igual al total (117.99): diferencia -0.01");
  });

  it("una diferencia grande también bloquea y se informa exacta", () => {
    const [e] = errores([conTotal(COL, "123.00")]);
    expect(e?.codigo).toBe("CUADRE");
    expect(e?.diferencia?.toString()).toBe("5.00");
  });

  it("nota de crédito: componentes negativos, total -118.01 da diferencia -0.01", () => {
    const [e] = errores([conTotal({ biDg: "-100.00", igvDg: "-18.00" }, "-118.01")]);
    expect(e?.codigo).toBe("CUADRE");
    expect(e?.diferencia?.toString()).toBe("-0.01");
    expect(e?.explicacion).toBe("La suma de componentes (-118.00) no es igual al total (-118.01): diferencia -0.01");
  });

  it("USD: la diferencia sale en USD", () => {
    const f = filaReemplazo(COL, {
      moneda: "USD",
      tipoCambio: "3.300",
      montos: MontosComprobante.desde("USD", { ...COL, total: "118.01" }),
    });
    const e = errores([f]).find((x) => x.codigo === "CUADRE");
    expect(e?.diferencia?.moneda).toBe("USD");
    expect(e?.diferencia?.toString()).toBe("0.01");
  });

  it("sin reglas no hay sugerencia; con reglas trae la de R-RED (ajustar el total a la suma)", () => {
    const f = conTotal(COL, "118.01");
    expect(errores([f])[0]?.sugerencia).toBeNull();
    const s = errores([f], true).find((x) => x.codigo === "CUADRE")?.sugerencia;
    expect(s?.regla).toBe("R-RED");
    expect(s?.sugerencia).toEqual({ tipo: "ajustar", valores: { total: expect.anything() } });
    const total = s?.sugerencia?.tipo === "ajustar" ? s.sugerencia.valores.total : undefined;
    expect(total?.toString()).toBe("118.00");
  });

  it("los errores que no son de cuadre no traen diferencia", () => {
    const e = errores([filaReemplazo({ biDg: "100.00", igvDg: "20.00" })]);
    expect(e.every((x) => x.diferencia === null)).toBe(true);
  });

  it("propiedad (oráculo en centavos enteros): hay CUADRE si y solo si total != Σ columnas", () => {
    fc.assert(
      fc.property(arbFila(), fc.integer({ min: -3, max: 3 }), (fila, delta) => {
        const v = valores(fila);
        const suma = Object.values(fila).reduce((s, x) => s + x, 0);
        v.total = centavosAString(suma + delta);
        const { total, ...columnas } = v;
        const f = filaReemplazo(columnas as Columnas, { montos: MontosComprobante.desde("PEN", { ...columnas, total: total! }) });
        const cuadre = errores([f]).filter((e) => e.codigo === "CUADRE");
        expect(cuadre.length).toBe(delta === 0 ? 0 : 1);
        if (delta !== 0) expect(cuadre[0]?.diferencia?.toString()).toBe(centavosAString(delta));
      }),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});

describe("IGV por destino · 18 % o 10 % con ±0.01 (D1, D11)", () => {
  const DESTINOS = [
    ["DG", "biDg", "igvDg"],
    ["DGNG", "biDgng", "igvDgng"],
    ["DNG", "biDng", "igvDng"],
  ] as const;

  describe.each(DESTINOS)("destino %s", (destino, bi, igv) => {
    const fila = (igvValor: string) => filaReemplazo({ [bi]: "100.00", [igv]: igvValor } as Columnas);

    it.each(["18.00", "18.01", "17.99", "10.00", "10.01", "9.99"])("IGV %s cuadra (borde de ±0.01)", (v) => {
      expect(errores([fila(v)])).toEqual([]);
    });

    it.each(["18.02", "17.98", "10.02", "9.98", "14.00", "100.00"])("IGV %s no cuadra: error IGV con campo, destino y explicación", (v) => {
      const [e, ...resto] = errores([fila(v)]);
      expect(resto).toEqual([]);
      expect(e).toMatchObject({ filaId: "f1", codigo: "IGV", campo: igv, destino });
      expect(e?.explicacion).toBe(`${v} no es 18 % ni 10 % de 100.00`);
      expect(e?.diferencia).toBeNull();
    });
  });

  it("caso real: 1.61 sobre 21.48 es la explicación exacta de CA-1", () => {
    const [e] = errores([filaReemplazo({ biDg: "21.48", igvDg: "1.61" })]);
    expect(e).toMatchObject({ codigo: "IGV", campo: "igvDg", destino: "DG" });
    expect(e?.explicacion).toBe("1.61 no es 18 % ni 10 % de 21.48");
  });

  it("con reglas, el error IGV trae la sugerencia de R-MIX (separar en 8.92-8.97)", () => {
    const s = errores([filaReemplazo({ biDg: "21.48", igvDg: "1.61" })], true).find((e) => e.codigo === "IGV")?.sugerencia;
    expect(s?.regla).toBe("R-MIX");
    expect(s?.destino).toBe("DG");
    expect(s?.sugerencia?.tipo).toBe("separar");
  });

  it("IGV 0.00 con base distinta de cero no es error IGV (San Juan, CA-1: solo R-ISC avisa)", () => {
    expect(errores([filaReemplazo({ biDg: "770.00", igvDg: "0.00" })])).toEqual([]);
    expect(errores([filaReemplazo({ biDgng: "770.00", igvDgng: "0.00" })])).toEqual([]);
    expect(errores([filaReemplazo({ biDng: "770.00", igvDng: "0.00" })])).toEqual([]);
  });

  it("base 0.00 con IGV mayor que cero es error IGV", () => {
    const [e] = errores([filaReemplazo({ biDg: "0.00", igvDg: "5.00" })]);
    expect(e).toMatchObject({ codigo: "IGV", campo: "igvDg", destino: "DG" });
    expect(e?.explicacion).toBe("5.00 no es 18 % ni 10 % de 0.00");
  });

  it("signos distintos (base positiva e IGV negativo, o al revés) son error IGV", () => {
    const a = errores([filaReemplazo({ biDg: "100.00", igvDg: "-18.00" })]);
    expect(a.map((e) => e.codigo)).toEqual(["IGV"]);
    expect(a[0]?.explicacion).toBe("-18.00 no es 18 % ni 10 % de 100.00");
    const b = errores([filaReemplazo({ biDg: "-100.00", igvDg: "18.00" })]);
    expect(b.map((e) => e.codigo)).toEqual(["IGV"]);
    expect(b[0]?.explicacion).toBe("18.00 no es 18 % ni 10 % de -100.00");
  });

  it("nota de crédito: -100.00 con -18.00 / -18.01 / -17.99 cuadra; -18.02 no, con la cifra canónica con signo", () => {
    for (const v of ["-18.00", "-18.01", "-17.99", "-10.00"]) {
      expect(errores([filaReemplazo({ biDg: "-100.00", igvDg: v })])).toEqual([]);
    }
    const [e] = errores([filaReemplazo({ biDg: "-100.00", igvDg: "-18.02" })]);
    expect(e?.codigo).toBe("IGV");
    expect(e?.explicacion).toBe("-18.02 no es 18 % ni 10 % de -100.00");
  });

  it("varios destinos: cada destino que no cuadra da su propio error, en el orden del campo", () => {
    const e = errores([filaReemplazo({ biDg: "100.00", igvDg: "20.00", biDgng: "100.00", igvDgng: "20.00", biDng: "100.00", igvDng: "18.00" })]);
    expect(e.map((x) => [x.codigo, x.campo, x.destino])).toEqual([
      ["IGV", "igvDg", "DG"],
      ["IGV", "igvDgng", "DGNG"],
    ]);
  });

  it("USD: el IGV se evalúa en la moneda de la fila (0.15 con 0.03 cuadra a 18 %)", () => {
    expect(errores([filaReemplazo({ biDg: "0.15", igvDg: "0.03" }, { moneda: "USD", tipoCambio: "3.300" })])).toEqual([]);
  });

  it("propiedad (oráculo en centavos enteros): error IGV si y solo si IGV != 0 y se aleja más de 0.01 de ambas tasas", () => {
    // Redondeo SUNAT: mitad hacia arriba (base >= 0 en esta propiedad).
    const esperado = (b: number, pct: number) => Math.floor((b * pct + 50) / 100);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.constantFrom(18, 10, 7),
        fc.integer({ min: -3, max: 3 }),
        fc.boolean(),
        (b, pct, delta, ceroForzado) => {
          const centro = esperado(b, pct);
          const g = ceroForzado ? 0 : Math.max(0, centro + delta);
          const hayError =
            g !== 0 && Math.abs(g - esperado(b, 18)) > 1 && Math.abs(g - esperado(b, 10)) > 1;
          const f = filaReemplazo({ biDg: centavosAString(b), igvDg: centavosAString(g) });
          const e = errores([f]);
          expect(e.map((x) => x.codigo)).toEqual(hayError ? ["IGV"] : []);
        },
      ),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});

describe("CA-4 · moneda USD y tipo de cambio (sintético)", () => {
  const usd = (tipoCambio: string | null) =>
    filaReemplazo({ biDg: "100.00", igvDg: "18.00" }, { moneda: "USD", tipoCambio });

  it("USD sin tipo de cambio da USD_SIN_TC que nombra tipoCambio", () => {
    const [e, ...resto] = errores([usd(null)]);
    expect(resto).toEqual([]);
    expect(e).toMatchObject({ filaId: "f1", codigo: "USD_SIN_TC", campo: "tipoCambio" });
  });

  it.each(["3.300", "3.3", "3", "0.001", "9999.999", "3.299"])("TC %j es válido", (tc) => {
    expect(errores([usd(tc)])).toEqual([]);
  });

  it.each([
    ["más de 3 decimales", "3.3001"],
    ["cero con 3 decimales", "0.000"],
    ["cero", "0"],
    ["negativo", "-3.300"],
    ["coma decimal", "3,300"],
    ["letras", "abc"],
    ["cadena vacía", ""],
    ["espacio inicial", " 3.300"],
    ["salto de línea final", "3.300\n"],
    ["5 enteros", "10000"],
    ["notación científica", "3e0"],
    ["dígitos no ASCII", "\u0663.300"],
  ])("TC %s da TC_INVALIDO que nombra tipoCambio", (_n, tc) => {
    const e = errores([usd(tc)]);
    expect(e).toContainEqual(expect.objectContaining({ filaId: "f1", codigo: "TC_INVALIDO", campo: "tipoCambio" }));
    expect(e.map((x) => x.codigo)).not.toContain("USD_SIN_TC");
  });

  it("una fila PEN con tipoCambio no nulo da TC_INVALIDO en tipoCambio (no se descarta en silencio; T6)", () => {
    for (const tc of ["3.300", "1.000", ""]) {
      expect(errores([filaReemplazo(undefined, { tipoCambio: tc })])).toContainEqual(
        expect.objectContaining({ filaId: "f1", codigo: "TC_INVALIDO", campo: "tipoCambio" }),
      );
    }
  });

  it("la fila USD del fixture (TC 3.300) no tiene errores", () => {
    expect(errores([usd("3.300")])).toEqual([]);
  });

  describe("fila PEN con origenUsd (D7 de 010: conversión por componente)", () => {
    // 100.00 USD x 3.300 = 330.00; 18.00 x 3.300 = 59.40; total 389.40.
    const origen = (tipoCambio = "3.300") => ({ montos: montosDe("USD", { biDg: "100.00", igvDg: "18.00" }), tipoCambio });
    const pen = (c: Columnas, o = origen()) => filaReemplazo(c, { origenUsd: o });

    it("montos que coinciden con la conversión no dan error", () => {
      expect(errores([pen({ biDg: "330.00", igvDg: "59.40" })])).toEqual([]);
    });

    it.each([
      ["una columna distinta por 0.01", { biDg: "330.01", igvDg: "59.40" }],
      ["el IGV distinto por 0.01", { biDg: "330.00", igvDg: "59.41" }],
      ["los montos sin convertir", { biDg: "100.00", igvDg: "18.00" }],
    ])("%s da CONVERSION_USD que nombra el campo", (_n, columnas) => {
      const e = errores([pen(columnas as Columnas)]);
      const c = e.find((x) => x.codigo === "CONVERSION_USD");
      expect(c).toMatchObject({ filaId: "f1", campo: "origenUsd" });
      expect(typeof c?.explicacion).toBe("string");
    });

    it("con reglas, CONVERSION_USD trae la sugerencia de R-RED con los montos convertidos", () => {
      const s = errores([pen({ biDg: "330.01", igvDg: "59.40" })], true).find((x) => x.codigo === "CONVERSION_USD")?.sugerencia;
      expect(s?.regla).toBe("R-RED");
      expect(s?.sugerencia?.tipo).toBe("ajustar");
    });

    it("origenUsd con montos USD descuadrados da CONVERSION_USD y no lanza (convertirAPen no se llama; T6)", () => {
      const descuadrado = { montos: MontosComprobante.desde("USD", { biDg: "100.00", igvDg: "18.00", total: "118.01" }), tipoCambio: "3.300" };
      let e: readonly ErrorPrevalidacion[] = [];
      expect(() => {
        e = errores([pen({ biDg: "330.00", igvDg: "59.40" }, descuadrado)]);
      }).not.toThrow();
      expect(e).toContainEqual(expect.objectContaining({ filaId: "f1", codigo: "CONVERSION_USD", campo: "origenUsd" }));
    });

    it("el TC de origenUsd inválido da TC_INVALIDO", () => {
      const e = errores([pen({ biDg: "330.00", igvDg: "59.40" }, origen("3.3001"))]);
      expect(e.map((x) => x.codigo)).toContain("TC_INVALIDO");
    });
  });
});
