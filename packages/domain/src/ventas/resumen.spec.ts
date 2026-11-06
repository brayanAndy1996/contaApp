// Spec 013 (T3, rojo): resumirVentas(filas) (RF-056, D11, P-10; CA-9). Todo en soles, con Money, sin `number` para dinero.
// Contrato que fija la prueba (T9, `packages/domain/src/ventas/index.ts`):
//   fila:      { clave, tipo, moneda: "PEN" | "USD", tipoCambio?: string | null, baseGravada, igv, exonerada, inafecta, isc,
//                icbper, otros, total }   — todos los montos y el tipo de cambio, cadenas decimales (como las da NUMERIC)
//   resultado: { porTipo: Totales & { tipo }[], total: Totales, sinConvertir: { clave, moneda }[], avisos: "usd_sin_tipo_cambio"[] }
//   Totales:   { cantidad: number, baseGravada, igv, exonerada, inafecta, isc, icbper, otros, total }  (montos: cadenas de 2 decimales)
//   - `porTipo` ordenado por tipo (texto); `total` = la suma de las filas sumadas (mismas claves que Totales, sin `tipo`);
//   - una fila USD se convierte columna por columna: redondearSunat(columna × tc) (010 D7) y su `total` = Σ de las siete columnas
//     convertidas (no el total USD × tc); una fila PEN suma su `total` tal como llegó (no se corrige la descuadrada);
//   - una fila USD sin tipo de cambio NO se suma (ni en `cantidad`): sale en `sinConvertir` y `avisos` = ["usd_sin_tipo_cambio"];
//   - las notas de crédito traen montos negativos y restan; el redondeo es half-up alejándose de cero;
//   - no muta la entrada y no lanza con una lista vacía.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, TipoCambio, redondearSunat } from "../index";
import { NUM_RUNS, SEMILLA } from "../../tests/ayudas/comprobante";
import { FIXTURE_VENTAS_202610 } from "../../tests/ayudas/ventas";
import { resumirVentas } from "./index";

interface Fila {
  clave: string;
  tipo: string;
  moneda: "PEN" | "USD";
  tipoCambio?: string | null;
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}
const COLUMNAS = ["baseGravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"] as const;

const fila = (tipo: string, serie: string, numero: string, montos: Partial<Fila> = {}): Fila => ({
  clave: `${tipo}|${serie}|${numero}`,
  tipo,
  moneda: "PEN",
  tipoCambio: null,
  baseGravada: "0.00",
  igv: "0.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "0.00",
  ...montos,
});
const CERO = { baseGravada: "0.00", igv: "0.00", exonerada: "0.00", inafecta: "0.00", isc: "0.00", icbper: "0.00", otros: "0.00", total: "0.00" };

describe("resumirVentas · por tipo (CA-9)", () => {
  it("suma cantidad y cada columna por tipo, y el total general", () => {
    const r = resumirVentas([
      fila("03", "B001", "290", { baseGravada: "100.00", igv: "18.00", total: "118.00" }),
      fila("03", "B001", "292", { baseGravada: "50.00", igv: "9.00", total: "59.00" }),
      fila("01", "F001", "10", { baseGravada: "200.00", igv: "36.00", total: "236.00" }),
    ]);
    expect(r.porTipo).toEqual([
      { tipo: "01", cantidad: 1, ...CERO, baseGravada: "200.00", igv: "36.00", total: "236.00" },
      { tipo: "03", cantidad: 2, ...CERO, baseGravada: "150.00", igv: "27.00", total: "177.00" },
    ]);
    expect(r.total).toEqual({ cantidad: 3, ...CERO, baseGravada: "350.00", igv: "63.00", total: "413.00" });
    expect(r.sinConvertir).toEqual([]);
    expect(r.avisos).toEqual([]);
  });

  it("incluye exonerada e inafecta (un cliente de la Amazonía no ve ceros) y ISC, ICBPER y otros", () => {
    const r = resumirVentas([
      fila("01", "F001", "12", { exonerada: "150.00", total: "150.00" }),
      fila("01", "F001", "13", { inafecta: "40.25", isc: "5.00", icbper: "0.50", otros: "1.10", total: "46.85" }),
    ]);
    expect(r.porTipo).toEqual([
      { tipo: "01", cantidad: 2, ...CERO, exonerada: "150.00", inafecta: "40.25", isc: "5.00", icbper: "0.50", otros: "1.10", total: "196.85" },
    ]);
  });

  it("los tipos salen ordenados, sin importar el orden de las filas", () => {
    const r = resumirVentas([fila("07", "F001", "1"), fila("03", "B001", "1"), fila("01", "F001", "1"), fila("03", "B002", "1")]);
    expect(r.porTipo.map((x) => [x.tipo, x.cantidad])).toEqual([
      ["01", 1],
      ["03", 2],
      ["07", 1],
    ]);
  });

  it("la nota de crédito (montos negativos) resta: la suma del tipo 07 es negativa y el total general baja", () => {
    const r = resumirVentas([
      fila("01", "F001", "10", { baseGravada: "200.00", igv: "36.00", total: "236.00" }),
      fila("07", "F001", "1", { baseGravada: "-50.00", igv: "-9.00", total: "-59.00" }),
    ]);
    expect(r.porTipo.find((x) => x.tipo === "07")).toEqual({ tipo: "07", cantidad: 1, ...CERO, baseGravada: "-50.00", igv: "-9.00", total: "-59.00" });
    expect(r.total).toMatchObject({ cantidad: 2, baseGravada: "150.00", igv: "27.00", total: "177.00" });
  });

  it("una lista vacía da ceros y ninguna entrada, sin lanzar", () => {
    expect(resumirVentas([])).toEqual({
      porTipo: [],
      total: { cantidad: 0, ...CERO },
      sinConvertir: [],
      avisos: [],
    });
  });

  it("la fila descuadrada (PEN) suma tal como llegó: no se corrige (D3)", () => {
    const r = resumirVentas([fila("03", "B001", "1", { baseGravada: "100.00", igv: "18.00", total: "119.00" })]);
    expect(r.porTipo[0]).toMatchObject({ baseGravada: "100.00", igv: "18.00", total: "119.00" });
  });
});

describe("resumirVentas · exactitud decimal, sin number (CA-9)", () => {
  it("1000 filas de 0.10 suman exactamente 100.00 (no 99.9999…)", () => {
    const filas = Array.from({ length: 1000 }, (_, i) => fila("03", "B001", String(i + 1), { baseGravada: "0.10", total: "0.10" }));
    const r = resumirVentas(filas);
    expect(r.total.baseGravada).toBe("100.00");
    expect(r.total.total).toBe("100.00");
    expect(r.total.cantidad).toBe(1000);
  });

  it("0.10 + 0.20 es 0.30 y los montos de salida son cadenas; solo `cantidad` es numérico", () => {
    const r = resumirVentas([fila("03", "B001", "1", { baseGravada: "0.10" }), fila("03", "B001", "2", { baseGravada: "0.20" })]);
    expect(r.total.baseGravada).toBe("0.30");
    for (const x of [...r.porTipo, r.total]) {
      expect(typeof x.cantidad).toBe("number");
      for (const c of COLUMNAS) {
        expect(typeof x[c], c).toBe("string");
        expect(x[c], c).toMatch(/^-?[0-9]+\.[0-9]{2}$/);
      }
    }
  });

  it("el máximo de NUMERIC(14,2) pasa intacto", () => {
    const r = resumirVentas([fila("01", "F001", "1", { baseGravada: "999999999999.99", total: "999999999999.99" })]);
    expect(r.total.total).toBe("999999999999.99");
  });
});

describe("resumirVentas · USD convertida por columna (D11, CA-9; 010 D7)", () => {
  it("USD con tipo de cambio: cada columna × tc con redondearSunat y total = Σ columnas (200 + 36 a 3.300 = 778.80)", () => {
    const r = resumirVentas([fila("01", "F002", "1", { moneda: "USD", tipoCambio: "3.300", baseGravada: "200.00", igv: "36.00", total: "236.00" })]);
    expect(r.porTipo).toEqual([{ tipo: "01", cantidad: 1, ...CERO, baseGravada: "660.00", igv: "118.80", total: "778.80" }]);
    expect(r.sinConvertir).toEqual([]);
    expect(r.avisos).toEqual([]);
  });

  it("redondeo USD (caso real): 0.15 y 0.03 a 3.300 dan 0.50 y 0.10 y el total es 0.60, no 0.59 (0.18 × 3.300 = 0.594)", () => {
    const r = resumirVentas([fila("01", "F002", "5", { moneda: "USD", tipoCambio: "3.300", baseGravada: "0.15", igv: "0.03", total: "0.18" })]);
    expect(r.total).toEqual({ cantidad: 1, ...CERO, baseGravada: "0.50", igv: "0.10", total: "0.60" });
  });

  it("half-up alejándose de cero también en negativo: una NC en USD de -0.15 y -0.03 da -0.50, -0.10 y -0.60", () => {
    const r = resumirVentas([fila("07", "F002", "1", { moneda: "USD", tipoCambio: "3.300", baseGravada: "-0.15", igv: "-0.03", total: "-0.18" })]);
    expect(r.total).toMatchObject({ baseGravada: "-0.50", igv: "-0.10", total: "-0.60" });
  });

  it("el total de una USD descuadrada es la suma de sus columnas convertidas, no su total × tc", () => {
    const r = resumirVentas([fila("01", "F002", "6", { moneda: "USD", tipoCambio: "3.000", baseGravada: "100.00", igv: "18.00", total: "119.00" })]);
    expect(r.total).toMatchObject({ baseGravada: "300.00", igv: "54.00", total: "354.00" });
  });

  it("convierte las ocho columnas, incluidas exonerada, inafecta, ISC, ICBPER y otros", () => {
    const r = resumirVentas([
      fila("01", "F002", "7", {
        moneda: "USD",
        tipoCambio: "3.500",
        exonerada: "10.00",
        inafecta: "20.00",
        isc: "1.00",
        icbper: "0.10",
        otros: "2.00",
        total: "33.10",
      }),
    ]);
    expect(r.total).toEqual({ cantidad: 1, ...CERO, exonerada: "35.00", inafecta: "70.00", isc: "3.50", icbper: "0.35", otros: "7.00", total: "115.85" });
  });

  it("mezcla PEN y USD en el mismo tipo: se suman en soles", () => {
    const r = resumirVentas([
      fila("01", "F001", "10", { baseGravada: "200.00", igv: "36.00", total: "236.00" }),
      fila("01", "F002", "1", { moneda: "USD", tipoCambio: "3.300", baseGravada: "200.00", igv: "36.00", total: "236.00" }),
    ]);
    expect(r.porTipo).toEqual([{ tipo: "01", cantidad: 2, ...CERO, baseGravada: "860.00", igv: "154.80", total: "1014.80" }]);
  });
});

describe("resumirVentas · USD sin tipo de cambio (P-10, CA-9)", () => {
  const sinTc = fila("01", "F002", "2", { moneda: "USD", baseGravada: "100.00", igv: "18.00", total: "118.00" });

  it("no se suma: sale en sinConvertir con su clave y moneda, y la respuesta trae el aviso", () => {
    const r = resumirVentas([fila("01", "F001", "10", { baseGravada: "200.00", igv: "36.00", total: "236.00" }), sinTc]);
    expect(r.sinConvertir).toEqual([{ clave: "01|F002|2", moneda: "USD" }]);
    expect(r.avisos).toEqual(["usd_sin_tipo_cambio"]);
    expect(r.total).toEqual({ cantidad: 1, ...CERO, baseGravada: "200.00", igv: "36.00", total: "236.00" });
  });

  it("el tipo de cambio nulo o ausente es lo mismo; varias filas dan un solo aviso y todas sus claves", () => {
    const r = resumirVentas([
      { ...sinTc, tipoCambio: null },
      { ...sinTc, clave: "01|F002|3", tipoCambio: undefined },
      { ...sinTc, clave: "01|F002|4", tipoCambio: "" },
    ]);
    expect(r.sinConvertir.map((x) => x.clave)).toEqual(["01|F002|2", "01|F002|3", "01|F002|4"]);
    expect(r.avisos).toEqual(["usd_sin_tipo_cambio"]);
    expect(r.porTipo).toEqual([]);
    expect(r.total).toEqual({ cantidad: 0, ...CERO });
  });

  it("una venta PEN con tipo de cambio de más no cuenta como sin convertir (el tc solo importa en USD)", () => {
    const r = resumirVentas([fila("03", "B001", "1", { baseGravada: "10.00", total: "10.00", tipoCambio: "3.300" })]);
    expect(r.sinConvertir).toEqual([]);
    expect(r.total.baseGravada).toBe("10.00");
  });
});

describe("resumirVentas · fixture del contribuyente de prueba (CA-9)", () => {
  const filas: Fila[] = FIXTURE_VENTAS_202610.map(({ serie, numero, ...resto }) => ({ ...resto, clave: `${resto.tipo}|${serie}|${numero}` }));
  const r = resumirVentas(filas);

  it("por tipo: 01 (4 filas, con la USD a 3.300), 03 (5 filas) y 07 (la nota de crédito resta)", () => {
    expect(r.porTipo).toEqual([
      { tipo: "01", cantidad: 4, ...CERO, baseGravada: "1160.00", igv: "208.80", exonerada: "150.00", total: "1518.80" },
      { tipo: "03", cantidad: 5, ...CERO, baseGravada: "275.00", igv: "49.50", total: "324.50" },
      { tipo: "07", cantidad: 1, ...CERO, baseGravada: "-50.00", igv: "-9.00", total: "-59.00" },
    ]);
  });

  it("total general en soles y la F002-2 (USD sin tipo de cambio) aparte, con el aviso", () => {
    expect(r.total).toEqual({ cantidad: 10, ...CERO, baseGravada: "1385.00", igv: "249.30", exonerada: "150.00", total: "1784.30" });
    expect(r.sinConvertir).toEqual([{ clave: "01|F002|2", moneda: "USD" }]);
    expect(r.avisos).toEqual(["usd_sin_tipo_cambio"]);
  });
});

describe("resumirVentas · la suma de los tipos iguala a la de las filas (CA-9)", () => {
  const sumar = (xs: string[]) => Money.suma(xs.map((x) => Money.desde(x, "PEN")), "PEN").toString();

  it("agregadas incluidas: añadir una fila `manual` más la suma sigue cuadrando", () => {
    const r = resumirVentas([
      fila("03", "B001", "290", { baseGravada: "100.00", igv: "18.00", total: "118.00" }),
      fila("03", "B001", "291", { baseGravada: "40.00", igv: "7.20", total: "47.20" }),
      fila("03", "B001", "292", { baseGravada: "50.00", igv: "9.00", total: "59.00" }),
    ]);
    expect(r.total.total).toBe("224.20");
    expect(r.porTipo[0]!.cantidad).toBe(3);
  });

  it("propiedad: por cada columna, el total general es la suma exacta de los tipos y la cantidad suma las filas sumadas", () => {
    const monto = fc.integer({ min: -2_000_000, max: 2_000_000 }).map((c) => {
      const signo = c < 0 ? "-" : "";
      const a = Math.abs(c);
      return `${signo}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, "0")}`;
    });
    const unaFila = fc.record({
      tipo: fc.constantFrom("01", "03", "07", "08"),
      moneda: fc.constantFrom<"PEN" | "USD">("PEN", "USD"),
      tc: fc.constantFrom<string | null>("3.300", "3.456", "0.999", "1", null),
      b: monto,
      i: monto,
      e: monto,
      o: monto,
    });
    fc.assert(
      fc.property(fc.array(unaFila, { maxLength: 40 }), (xs) => {
        const filas = xs.map((x, n) =>
          fila(x.tipo, "S001", String(n + 1), { moneda: x.moneda, tipoCambio: x.tc, baseGravada: x.b, igv: x.i, exonerada: x.e, otros: x.o, total: "0.00" }),
        );
        const r = resumirVentas(filas);
        for (const c of COLUMNAS) expect(r.total[c], c).toBe(sumar(r.porTipo.map((t) => t[c])));
        expect(r.total.cantidad).toBe(r.porTipo.reduce((a, t) => a + t.cantidad, 0));
        expect(r.total.cantidad + r.sinConvertir.length).toBe(filas.length);
        // La conversión de cada fila USD coincide con redondearSunat(columna × tc) (el oráculo de 010 D7).
        const esperado = filas
          .filter((f) => f.moneda === "PEN" || (f.tipoCambio ?? "") !== "")
          .reduce((acc, f) => {
            const cols = (["baseGravada", "igv", "exonerada", "otros"] as const).map((c) =>
              f.moneda === "USD"
                ? Money.desde(redondearSunat(Money.desde(f[c], "USD").por(TipoCambio.desde(f.tipoCambio as string))).toString(), "PEN")
                : Money.desde(f[c], "PEN"),
            );
            return acc.sumar(Money.suma(cols, "PEN"));
          }, Money.cero("PEN"));
        const sumaColumnas = Money.suma(
          (["baseGravada", "igv", "exonerada", "otros"] as const).map((c) => Money.desde(r.total[c], "PEN")),
          "PEN",
        );
        expect(sumaColumnas.toString()).toBe(esperado.toString());
      }),
      { numRuns: NUM_RUNS, seed: SEMILLA },
    );
  });
});

describe("resumirVentas · no muta la entrada", () => {
  it("las filas congeladas no cambian y no se comparte la lista de salida entre llamadas", () => {
    const filas = Object.freeze([
      Object.freeze(fila("03", "B001", "1", { baseGravada: "1.00", total: "1.00" })),
      Object.freeze(fila("01", "F002", "1", { moneda: "USD", baseGravada: "1.00", total: "1.00" })),
    ]);
    const antes = JSON.stringify(filas);
    const a = resumirVentas(filas);
    const b = resumirVentas(filas);
    expect(JSON.stringify(filas)).toBe(antes);
    expect(a).toEqual(b);
    expect(a.sinConvertir).not.toBe(b.sinConvertir);
  });
});
