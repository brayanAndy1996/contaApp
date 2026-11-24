// Spec 026 · T1 (rojo). resolverMes(fuente) → MesProrrata (R-2, R-2b, R-5; CA-3).
// Contrato (plan 026): MesFuente = {periodo, declaraciones: Presentacion[], manual: MontosMes | null, sire: TotalesSire | null};
// MesProrrata = {periodo, origen: "declarado" | "manual" | "sire" | "falta", gravadas, exportaciones, noGravadas, total, avisos}.
// Supuestos de forma que fija esta prueba (T8 los respeta o los anota): Presentacion = Declaracion621 de `sunat` sin `periodo`
// (numeroOrden, tipo, ventasGravadasBase, exportaciones, noGravadas, …); MontosMes = {gravadas, exportaciones, noGravadas};
// TotalesSire = {pen: {baseGravada, exonerada, inafecta}, usd: {baseGravada, exonerada, inafecta, tipoCambio}[]}
// (`sire: null` = periodo de ventas no cargado; cargado sin filas = ceros); `avisos` son códigos de texto (como en 013).
// Los montos pueden ser Money o cadena: se comparan con String(...).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "../dinero/index";
import { resumirVentas } from "../ventas/index";
import { NUM_RUNS, SEMILLA } from "../../tests/ayudas/comprobante";
import { PEN_CERO, aCentimos, aTexto, presentacion } from "../../tests/ayudas/prorrata";
import { resolverMes } from "./meses";

const P = "202604";
const fuente = (f: Record<string, unknown> = {}) => ({ periodo: P, declaraciones: [], manual: null, sire: null, ...f });
const montos = (m: ReturnType<typeof resolverMes>) => [m.gravadas, m.exportaciones, m.noGravadas, m.total].map(String);
const avisos = (m: ReturnType<typeof resolverMes>) => [...(m.avisos as string[])].sort();

describe("resolverMes: declarado (PDT 621 vigente)", () => {
  it("toma base gravada, exportaciones y no gravadas de la presentación; total = suma de los tres", () => {
    const m = resolverMes(
      fuente({
        declaraciones: [
          presentacion({ ventasGravadasBase: "1000.00", ventasGravadasIgv: "180.00", exportaciones: "250.50", noGravadas: "49.50" }),
        ],
      }),
    );
    expect(m.periodo).toBe(P);
    expect(m.origen).toBe("declarado");
    expect(montos(m)).toEqual(["1000.00", "250.50", "49.50", "1300.00"]);
    expect(avisos(m)).toEqual([]);
  });

  it("el IGV, el crédito y la prorrata de la presentación no entran en los montos del mes (R-2)", () => {
    const m = resolverMes(
      fuente({
        declaraciones: [
          presentacion({
            ventasGravadasBase: "100.00",
            ventasGravadasIgv: "999.00",
            igvAdquisicionesDg: "888.00",
            igvAdquisicionesDgng: "777.00",
            prorrataUsada: "50.00",
          }),
        ],
      }),
    );
    expect(montos(m)).toEqual(["100.00", "0.00", "0.00", "100.00"]);
  });

  it("la rectificatoria de mayor número de orden queda vigente y la original no se borra de la entrada", () => {
    const original = presentacion({ numeroOrden: "1", tipo: "original", ventasGravadasBase: "1000.00" });
    const rectif = presentacion({ numeroOrden: "2", tipo: "rectificatoria", ventasGravadasBase: "1200.00", fechaPresentacion: "2026-02-10" });
    for (const declaraciones of [[original, rectif], [rectif, original]]) {
      const m = resolverMes(fuente({ declaraciones }));
      expect(m.origen).toBe("declarado");
      expect(String(m.gravadas)).toBe("1200.00");
    }
  });

  it("vigente = mayor número de orden, sin importar el tipo ni el orden de la lista: una original con más orden gana", () => {
    const rectif = presentacion({ numeroOrden: "2", tipo: "rectificatoria", ventasGravadasBase: "1200.00" });
    const original = presentacion({ numeroOrden: "3", tipo: "original", ventasGravadasBase: "1500.00" });
    expect(String(resolverMes(fuente({ declaraciones: [rectif, original] })).gravadas)).toBe("1500.00");
    expect(String(resolverMes(fuente({ declaraciones: [original, rectif] })).gravadas)).toBe("1500.00");
  });

  it("el número de orden se compara como número, no como texto: 10 > 9 y 15 dígitos", () => {
    const a = presentacion({ numeroOrden: "9", ventasGravadasBase: "1.00" });
    const b = presentacion({ numeroOrden: "10", ventasGravadasBase: "2.00" });
    expect(String(resolverMes(fuente({ declaraciones: [a, b] })).gravadas)).toBe("2.00");
    expect(String(resolverMes(fuente({ declaraciones: [b, a] })).gravadas)).toBe("2.00");
    const c = presentacion({ numeroOrden: "999999999999999", ventasGravadasBase: "3.00" });
    const d = presentacion({ numeroOrden: "1000000000000", ventasGravadasBase: "4.00" });
    expect(String(resolverMes(fuente({ declaraciones: [d, c] })).gravadas)).toBe("3.00");
  });

  it("acepta montos negativos (notas de crédito en el PDT) y los muestra tal cual", () => {
    const m = resolverMes(fuente({ declaraciones: [presentacion({ ventasGravadasBase: "-500.00", noGravadas: "100.00" })] }));
    expect(montos(m)).toEqual(["-500.00", "0.00", "100.00", "-400.00"]);
  });

  it("gana al manual y al SIRE (precedencia R-5) y no mezcla sus montos", () => {
    const m = resolverMes(
      fuente({
        declaraciones: [presentacion({ ventasGravadasBase: "100.00" })],
        manual: { gravadas: "777.00", exportaciones: "0.00", noGravadas: "0.00" },
        sire: { pen: { ...PEN_CERO, baseGravada: "555.00" }, usd: [] },
      }),
    );
    expect(m.origen).toBe("declarado");
    expect(montos(m)).toEqual(["100.00", "0.00", "0.00", "100.00"]);
  });

  it("un manual vivo bajo un declarado deja el aviso `manual_reemplazado`; sin manual no hay aviso", () => {
    const con = resolverMes(
      fuente({
        declaraciones: [presentacion()],
        manual: { gravadas: "1.00", exportaciones: "0.00", noGravadas: "0.00" },
      }),
    );
    expect(con.origen).toBe("declarado");
    expect(avisos(con)).toEqual(["manual_reemplazado"]);
    expect(avisos(resolverMes(fuente({ declaraciones: [presentacion()], sire: { pen: PEN_CERO, usd: [] } })))).toEqual([]);
  });
});

describe("resolverMes: manual", () => {
  it("sin declaración, el manual gana al SIRE y trae sus tres montos; sin avisos", () => {
    const m = resolverMes(
      fuente({
        manual: { gravadas: "10.10", exportaciones: "20.20", noGravadas: "30.30" },
        sire: { pen: { ...PEN_CERO, baseGravada: "555.00" }, usd: [] },
      }),
    );
    expect(m.origen).toBe("manual");
    expect(montos(m)).toEqual(["10.10", "20.20", "30.30", "60.60"]);
    expect(avisos(m)).toEqual([]);
  });

  it("un manual en cero es un mes válido «sin operaciones» (R-6), no un mes faltante", () => {
    const m = resolverMes(fuente({ manual: { gravadas: "0.00", exportaciones: "0.00", noGravadas: "0.00" } }));
    expect(m.origen).toBe("manual");
    expect(montos(m)).toEqual(["0.00", "0.00", "0.00", "0.00"]);
  });

  it("el manual con exportaciones desplaza al SIRE (R-2b: así se corrige un mes SIRE de un exportador)", () => {
    const m = resolverMes(
      fuente({
        manual: { gravadas: "100.00", exportaciones: "400.00", noGravadas: "0.00" },
        sire: { pen: { ...PEN_CERO, baseGravada: "500.00" }, usd: [] },
      }),
    );
    expect(m.origen).toBe("manual");
    expect(String(m.exportaciones)).toBe("400.00");
  });
});

describe("resolverMes: SIRE (ventas de 013)", () => {
  it("gravadas = base gravada, no gravadas = exoneradas + inafectas, exportaciones 0 con su aviso (R-2, R-2b)", () => {
    const m = resolverMes(fuente({ sire: { pen: { baseGravada: "1000.00", exonerada: "200.00", inafecta: "50.00" }, usd: [] } }));
    expect(m.origen).toBe("sire");
    expect(montos(m)).toEqual(["1000.00", "0.00", "250.00", "1250.00"]);
    expect(avisos(m)).toEqual(["sire_sin_exportaciones"]);
  });

  it("un periodo cargado sin filas es SIRE en 0 (con el aviso de exportaciones), no un mes faltante", () => {
    const m = resolverMes(fuente({ sire: { pen: PEN_CERO, usd: [] } }));
    expect(m.origen).toBe("sire");
    expect(montos(m)).toEqual(["0.00", "0.00", "0.00", "0.00"]);
    expect(avisos(m)).toEqual(["sire_sin_exportaciones"]);
  });

  it("las notas de crédito (montos negativos) restan", () => {
    const m = resolverMes(fuente({ sire: { pen: { baseGravada: "-300.00", exonerada: "-20.00", inafecta: "10.00" }, usd: [] } }));
    expect(montos(m)).toEqual(["-300.00", "0.00", "-10.00", "-310.00"]);
  });

  it("convierte cada fila USD como `resumirVentas` de 013: redondearSunat(columna × tc) fila a fila, no sobre la suma", () => {
    const fila = { baseGravada: "0.15", exonerada: "0.00", inafecta: "0.00", tipoCambio: "3.305" };
    // 0.15 × 3.305 = 0.49575 → 0.50 por fila (dos filas = 1.00; sumadas antes darían 0.30 × 3.305 = 0.9915 → 0.99)
    const m = resolverMes(fuente({ sire: { pen: PEN_CERO, usd: [fila, fila] } }));
    expect(String(m.gravadas)).toBe("1.00");
    const suma = resolverMes(fuente({ sire: { pen: { ...PEN_CERO, baseGravada: "0.10" }, usd: [fila, fila] } }));
    expect(String(suma.gravadas)).toBe("1.10");
  });

  it("convierte la columna gravada y cada no gravada por separado y redondea alejándose de cero (nota de crédito)", () => {
    const m = resolverMes(
      fuente({
        sire: {
          pen: PEN_CERO,
          usd: [
            { baseGravada: "100.00", exonerada: "10.00", inafecta: "0.00", tipoCambio: "3.305" },
            { baseGravada: "-0.15", exonerada: "0.15", inafecta: "0.15", tipoCambio: "3.305" },
          ],
        },
      }),
    );
    // gravadas: 330.50 − 0.50 · exoneradas: 33.05 + 0.50 · inafectas: 0 + 0.50 (no 0.30 × 3.305 = 0.99)
    expect(String(m.gravadas)).toBe("330.00");
    expect(String(m.noGravadas)).toBe("34.05");
    expect(String(m.total)).toBe("364.05");
  });

  it.each([
    ["sin tipo de cambio (null)", null],
    ["tipo de cambio vacío", ""],
    ["tipo de cambio cero", "0"],
    ["tipo de cambio ilegible", "abc"],
  ])("una fila USD %s no suma y deja el aviso `usd_sin_tipo_cambio` (R-2)", (_n, tipoCambio) => {
    const m = resolverMes(
      fuente({
        sire: {
          pen: { ...PEN_CERO, baseGravada: "10.00" },
          usd: [
            { baseGravada: "999.00", exonerada: "999.00", inafecta: "999.00", tipoCambio },
            { baseGravada: "100.00", exonerada: "0.00", inafecta: "0.00", tipoCambio: "3.000" },
          ],
        },
      }),
    );
    expect(montos(m)).toEqual(["310.00", "0.00", "0.00", "310.00"]);
    expect(avisos(m)).toEqual(["sire_sin_exportaciones", "usd_sin_tipo_cambio"]);
  });

  it("propiedad: gravadas y no gravadas coinciden con `resumirVentas` de 013 para cualquier mezcla PEN/USD, y el aviso USD con sinConvertir", () => {
    const monto = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }).map((c) => aTexto(BigInt(c)));
    const fila = fc.record({
      moneda: fc.constantFrom("PEN", "USD", "USD"),
      baseGravada: monto,
      exonerada: monto,
      inafecta: monto,
      tipoCambio: fc.constantFrom("3.305", "3.7", "3.999", "0.5", "3.456", null),
    });
    fc.assert(
      fc.property(fc.array(fila, { maxLength: 30 }), (filas) => {
        const completas = filas.map((f, i) => ({
          clave: `01|F001|${i}`,
          tipo: "01",
          moneda: f.moneda as "PEN" | "USD",
          tipoCambio: f.moneda === "USD" ? f.tipoCambio : null,
          baseGravada: f.baseGravada,
          igv: "0.00",
          exonerada: f.exonerada,
          inafecta: f.inafecta,
          isc: "0.00",
          icbper: "0.00",
          otros: "0.00",
          total: "0.00",
        }));
        const esperado = resumirVentas(completas);
        const sumaPen = (c: "baseGravada" | "exonerada" | "inafecta") =>
          aTexto(filas.filter((f) => f.moneda === "PEN").reduce((s, f) => s + aCentimos(f[c]), 0n));
        const m = resolverMes(
          fuente({
            sire: {
              pen: { baseGravada: sumaPen("baseGravada"), exonerada: sumaPen("exonerada"), inafecta: sumaPen("inafecta") },
              usd: filas
                .filter((f) => f.moneda === "USD")
                .map((f) => ({ baseGravada: f.baseGravada, exonerada: f.exonerada, inafecta: f.inafecta, tipoCambio: f.tipoCambio })),
            },
          }),
        );
        const noGrav = Money.suma([Money.desde(esperado.total.exonerada, "PEN"), Money.desde(esperado.total.inafecta, "PEN")], "PEN");
        expect(String(m.gravadas)).toBe(esperado.total.baseGravada);
        expect(String(m.noGravadas)).toBe(noGrav.toString());
        expect((m.avisos as string[]).includes("usd_sin_tipo_cambio")).toBe(esperado.sinConvertir.length > 0);
        expect((m.avisos as string[]).includes("sire_sin_exportaciones")).toBe(true);
      }),
      { numRuns: NUM_RUNS, seed: SEMILLA },
    );
  });
});

describe("resolverMes: falta y entradas inválidas", () => {
  it("sin declaración, manual ni SIRE el mes falta", () => {
    const m = resolverMes(fuente());
    expect(m.origen).toBe("falta");
    expect(m.periodo).toBe(P);
  });

  it("un SIRE no cargado (null) con un manual en 0 sí tiene origen; con nada, falta", () => {
    expect(resolverMes(fuente({ sire: null })).origen).toBe("falta");
    expect(resolverMes(fuente({ manual: { gravadas: "0.00", exportaciones: "0.00", noGravadas: "0.00" } })).origen).toBe("manual");
  });

  it("no muta la entrada (congelada en profundidad)", () => {
    const congelar = <T>(o: T): T => {
      if (typeof o === "object" && o !== null) for (const v of Object.values(o)) congelar(v);
      return Object.freeze(o);
    };
    const f = congelar(
      fuente({
        declaraciones: [presentacion({ numeroOrden: "2" }), presentacion({ numeroOrden: "1" })],
        manual: { gravadas: "1.00", exportaciones: "0.00", noGravadas: "0.00" },
        sire: { pen: PEN_CERO, usd: [{ baseGravada: "1.00", exonerada: "0.00", inafecta: "0.00", tipoCambio: "3.3" }] },
      }),
    );
    expect(() => resolverMes(f)).not.toThrow();
    expect((f.declaraciones as { numeroOrden: string }[]).map((d) => d.numeroOrden)).toEqual(["2", "1"]);
  });

  it.each(["202613", "202600", "2026-04", "", "abcdef"])("periodo inválido %j lanza", (periodo) => {
    expect(() => resolverMes(fuente({ periodo }))).toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ["manual con `number`", { manual: { gravadas: 100, exportaciones: "0.00", noGravadas: "0.00" } }],
    ["manual con 3 decimales", { manual: { gravadas: "10.001", exportaciones: "0.00", noGravadas: "0.00" } }],
    ["manual con exponente", { manual: { gravadas: "1e3", exportaciones: "0.00", noGravadas: "0.00" } }],
    ["manual con espacios", { manual: { gravadas: " 1.00", exportaciones: "0.00", noGravadas: "0.00" } }],
    ["manual fuera de NUMERIC(14,2)", { manual: { gravadas: "1000000000000.00", exportaciones: "0.00", noGravadas: "0.00" } }],
    ["presentación con `number`", { declaraciones: [presentacion({ ventasGravadasBase: 100 as never })] }],
    ["presentación con 3 decimales", { declaraciones: [presentacion({ exportaciones: "1.234" })] }],
    ["SIRE con `number`", { sire: { pen: { ...PEN_CERO, baseGravada: 5 }, usd: [] } }],
    ["SIRE USD con `number` como monto", { sire: { pen: PEN_CERO, usd: [{ baseGravada: 5, exonerada: "0.00", inafecta: "0.00", tipoCambio: "3.3" }] } }],
  ])("monto inválido (%s) lanza: ningún monto entra como `number`", (_n, extra) => {
    expect(() => resolverMes(fuente(extra))).toThrow();
  });
});
