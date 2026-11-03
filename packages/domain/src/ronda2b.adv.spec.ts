// T13b · Ronda adversarial 2b (caja blanca), spec 010. Escenarios nuevos, distintos de T11a,
// T11b y T13a: superficie pública, serialización de filas completas, JSON hostil, monedas,
// tolerancias en el límite, casos reales con variaciones y rendimiento con entradas grandes.
// Cada prueba afirma el comportamiento seguro que exige un CA, una D o el plan (citado).
import { Decimal } from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Publico from "./index";
import {
  COLUMNAS_COMPRA,
  ComprobanteDescuadradoError,
  DineroError,
  Factor,
  MonedaDistintaError,
  Money,
  MontoExacto,
  MontoFueraDeRangoError,
  MontoInvalidoError,
  MontosComprobante,
  MovimientoInvalidoError,
  TASA_IGV_10,
  TASA_IGV_18,
  TOLERANCIA_CUADRE,
  TOLERANCIA_IGV,
  TipoCambio,
  Tolerancia,
  cambiarDestino,
  convertirAPen,
  igvCuadra,
  igvEsperado,
  moverMonto,
  redondearSunat,
  verificarCuadre,
} from "./index";
import type { ColumnaCompra, Cuadrable, Moneda, TasaIgv } from "./index";

type Ctor = new (...a: unknown[]) => object;
const OPCIONES = { seed: 20261025, numRuns: 1000 };

/** Céntimos → string canónico de Money. */
function aTexto(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
  return neg && a !== 0n ? `-${s}` : s;
}

/** Oráculo D1 independiente: céntimos de redondear (cents × t / 100) half-up alejándose de cero. */
function igvOraculo(cents: bigint, tasaPorCien: bigint): bigint {
  const n = cents * tasaPorCien;
  const a = n < 0n ? -n : n;
  const r = (a + 50n) / 100n;
  return n < 0n ? -r : r;
}

const pen = (s: string): Money => Money.desde(s, "PEN");
const usd = (s: string): Money => Money.desde(s, "USD");

/** Ejecuta f y devuelve el error lanzado (o undefined si no lanzó). */
function errorDe(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("T13b · ronda adversarial 2b", () => {
  it("R2b-1 · la superficie pública no filtra Decimal, D ni accesos internos, y las instancias falsas o subclases no producen montos (plan Contratos: nunca exporta Decimal; Inmutabilidad; R1b-3)", () => {
    const esperados = [
      "COLUMNAS_COMPRA", "ComprobanteDescuadradoError", "DineroError", "Factor", "FactorInvalidoError",
      "MonedaDistintaError", "Money", "MontoExacto", "MontoFueraDeRangoError", "MontoInvalidoError",
      "MontosComprobante", "MovimientoInvalidoError", "TASA_IGV_10", "TASA_IGV_18", "TOLERANCIA_CUADRE",
      "TOLERANCIA_IGV", "TipoCambio", "Tolerancia", "cambiarDestino", "convertirAPen", "igvCuadra",
      "igvEsperado", "moverMonto", "redondearSunat", "verificarCuadre",
      // 011: exports legítimos de texto/ (T8) y reglas/ (T10).
      "ConfirmacionInvalidaError", "DICCIONARIO_GLOSAS_BASE", "DiccionarioGlosas", "EntradaReglasInvalidaError",
      "ORDEN_REGLAS", "ReglasError", "SugerenciaObsoletaError", "aplicarMasivo", "aplicarSugerencia",
      "evaluarReglas", "tokensDeGlosa",
    ].sort();
    expect(Object.keys(Publico).sort()).toEqual(esperados);

    const fila = MontosComprobante.desde("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const muestras: unknown[] = [
      ...Object.values(Publico),
      pen("12.34"), MontoExacto.desde("1.2345678901", "PEN"), pen("1.00").por(TASA_IGV_18),
      pen("1.00").entre(Factor.desde("3")), Factor.desde("0.18"), TipoCambio.desde("3.305"),
      Tolerancia.desde("0.01"), fila, fila.componentes(), fila.toJSON(), verificarCuadre(fila, TOLERANCIA_CUADRE),
      cambiarDestino(fila, "DNG"), convertirAPen(fila, TipoCambio.desde("3.3")),
    ];
    // Recorre todo lo alcanzable por propiedades propias (incluidos símbolos) hasta profundidad 4.
    const vistos = new Set<unknown>();
    const filtrados: string[] = [];
    const recorrer = (v: unknown, ruta: string, prof: number): void => {
      if ((typeof v !== "object" && typeof v !== "function") || v === null || vistos.has(v)) return;
      vistos.add(v);
      if (v instanceof Decimal || Decimal.isDecimal(v)) filtrados.push(`${ruta}: instancia Decimal`);
      if (typeof v === "function" && "ROUND_HALF_UP" in v && "clone" in v) filtrados.push(`${ruta}: constructor Decimal`);
      if (prof === 0 || v === Function.prototype || v === Object.prototype) return;
      for (const k of Reflect.ownKeys(v)) {
        const desc = Object.getOwnPropertyDescriptor(v, k);
        if (desc && "value" in desc) recorrer(desc.value, `${ruta}.${String(k)}`, prof - 1);
      }
    };
    muestras.forEach((m, i) => recorrer(m, `muestra[${i}]`, 4));
    expect(filtrados).toEqual([]);

    // Las instancias solo exponen sus campos públicos de solo lectura.
    expect(Reflect.ownKeys(pen("1.00"))).toEqual(["moneda"]);
    expect(Reflect.ownKeys(MontoExacto.desde("1", "PEN"))).toEqual(["moneda"]);
    expect(Reflect.ownKeys(Factor.desde("1"))).toEqual([]);
    expect(Reflect.ownKeys(TipoCambio.desde("1"))).toEqual([]);
    expect(Reflect.ownKeys(Tolerancia.desde("1"))).toEqual([]);
    expect(Reflect.ownKeys(fila).sort()).toEqual(["moneda", "total"]);
    for (const congelado of [COLUMNAS_COMPRA, TASA_IGV_18, TASA_IGV_10, TOLERANCIA_CUADRE, TOLERANCIA_IGV, fila.componentes()]) {
      expect(Object.isFrozen(congelado)).toBe(true);
    }

    // Subclases y objetos con el prototipo de la clase: nunca crean ni lavan un monto.
    const clases: Ctor[] = [Money, MontoExacto, Factor, TipoCambio, Tolerancia, MontosComprobante] as unknown as Ctor[];
    for (const C of clases) {
      const Sub = class extends C {};
      expect(() => new Sub()).toThrow(TypeError);
    }
    const falso = <T>(C: unknown, props: Record<string, unknown> = {}): T => {
      const o = Object.create((C as { prototype: object }).prototype) as Record<string, unknown>;
      for (const [k, v] of Object.entries(props)) Object.defineProperty(o, k, { value: v, enumerable: true });
      return o as T;
    };
    const mF = falso<Money>(Money, { moneda: "PEN" });
    const xF = falso<MontoExacto>(MontoExacto, { moneda: "PEN" });
    const fF = falso<Factor>(Factor);
    const tcF = falso<TipoCambio>(TipoCambio);
    const tolF = falso<Tolerancia>(Tolerancia);
    const filaPen = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const filaF = falso<MontosComprobante>(MontosComprobante, { moneda: "PEN", total: pen("118.00") });
    const ataques: Array<[string, () => unknown]> = [
      ["Money.suma con falso", () => Money.suma([mF], "PEN")],
      ["sumar falso", () => pen("1.00").sumar(mF)],
      ["comparar falso", () => pen("1.00").comparar(mF)],
      ["falso.toString", () => String(mF)],
      ["JSON de falso", () => JSON.stringify(mF)],
      ["igvEsperado de falso", () => igvEsperado(mF, TASA_IGV_18)],
      ["moverMonto con monto falso", () => moverMonto(filaPen, "biDg", "isc", mF)],
      ["redondearSunat de exacto falso", () => redondearSunat(xF)],
      ["por factor falso", () => pen("1.00").por(fF)],
      ["entre factor falso", () => pen("1.00").entre(fF)],
      ["igvEsperado tasa falsa", () => igvEsperado(pen("1.00"), fF as TasaIgv)],
      ["convertirAPen tc falso", () => convertirAPen(fila, tcF)],
      ["verificarCuadre tolerancia falsa", () => verificarCuadre(filaPen, tolF)],
      ["igvCuadra tolerancia falsa", () => igvCuadra(pen("100.00"), pen("18.00"), TASA_IGV_18, tolF)],
      ["sumar fila falsa", () => filaPen.sumar(filaF)],
      ["moverMonto fila falsa", () => moverMonto(filaF, "biDg", "isc", pen("1.00"))],
      ["cambiarDestino fila falsa", () => cambiarDestino(filaF, "DNG")],
      ["verificarCuadre fila falsa", () => verificarCuadre(filaF, TOLERANCIA_CUADRE)],
    ];
    const aceptados = ataques.filter(([, f]) => errorDe(f) === undefined).map(([n]) => n);
    expect(aceptados).toEqual([]);
  });

  it("R2b-2 · las clases y sus prototipos están congelados: nadie puede reemplazar métodos ni Symbol.hasInstance para reabrir el lavado de R1b-6 (plan Inmutabilidad; spec Ataques: mutación de internos)", () => {
    const clases = { Money, MontoExacto, Factor, TipoCambio, Tolerancia, MontosComprobante };
    for (const [n, C] of Object.entries(clases)) {
      expect.soft(Object.isFrozen(C), `${n} congelada`).toBe(true);
      expect.soft(Object.isFrozen(C.prototype), `${n}.prototype congelado`).toBe(true);
    }
    // Impacto concreto: con un Symbol.hasInstance definido sobre la clase (sin tocar el código del
    // dominio), un objeto plano con columnas que no son Money vuelve a salir como MontosComprobante.
    let parcheado = false;
    try {
      Object.defineProperty(MontosComprobante, Symbol.hasInstance, { value: () => true, configurable: true });
      parcheado = true;
    } catch {
      parcheado = false;
    }
    try {
      const plano = {
        moneda: "PEN",
        total: pen("1.00"),
        obtener: (c: ColumnaCompra) => (c === "biDg" || c === "isc" ? pen("1.00") : "1e3"),
      } as unknown as MontosComprobante;
      let lavado: unknown = undefined;
      try {
        lavado = moverMonto(plano, "biDg", "isc", pen("1.00")).toJSON();
      } catch {
        lavado = undefined;
      }
      expect.soft(lavado, "objeto plano lavado como MontosComprobante").toBeUndefined();
    } finally {
      if (parcheado) Reflect.deleteProperty(MontosComprobante, Symbol.hasInstance);
    }
  });

  it("R2b-3 · ida y vuelta de filas completas por JSON y NUMERIC(14,2) es idéntica, sin number, y conserva el cuadre (Alcance Serialización, CA-11, D2, D4)", () => {
    const arbCent = fc.bigInt({ min: -99999999999n, max: 99999999999n });
    const arbFila = fc.record({
      moneda: fc.constantFrom<Moneda>("PEN", "USD"),
      cols: fc.array(fc.option(arbCent, { nil: undefined }), { minLength: 10, maxLength: 10 }),
      total: fc.option(arbCent, { nil: undefined }),
    });
    const sinNumeros = /[:,[]\s*-?[0-9]/;
    fc.assert(
      fc.property(arbFila, ({ moneda, cols, total }) => {
        const v: Partial<Record<ColumnaCompra, string>> & { total: string } = { total: "0.00" };
        let suma = 0n;
        COLUMNAS_COMPRA.forEach((c, i) => {
          const x = cols[i];
          if (x !== undefined) {
            v[c] = aTexto(x);
            suma += x;
          }
        });
        v.total = aTexto(total ?? suma); // la mitad cuadra exacto, la otra casi nunca
        const m = MontosComprobante.desde(moneda, v);
        const s = JSON.stringify(m);
        expect(s).not.toMatch(sinNumeros);
        const p = JSON.parse(s) as { moneda: Moneda; total: string; columnas: Record<ColumnaCompra, string> };
        expect(Object.keys(p.columnas)).toEqual([...COLUMNAS_COMPRA]);
        const m2 = MontosComprobante.desde(p.moneda, { ...p.columnas, total: p.total });
        expect(JSON.stringify(m2)).toBe(s);
        for (const c of COLUMNAS_COMPRA) {
          const pg = Money.desdeNumeric(p.columnas[c], p.moneda);
          expect(pg.igual(m.obtener(c))).toBe(true);
          expect(pg.toString()).toBe(p.columnas[c]);
          expect(Money.desdeJSON(JSON.parse(JSON.stringify(m.obtener(c)))).igual(m.obtener(c))).toBe(true);
        }
        const r1 = verificarCuadre(m, TOLERANCIA_CUADRE);
        const r2 = verificarCuadre(m2, TOLERANCIA_CUADRE);
        const j1 = JSON.stringify(r1);
        expect(j1).toBe(JSON.stringify(r2));
        expect(j1.replace(/"cuadra":(true|false)/, "")).not.toMatch(sinNumeros);
        expect(r1.cuadra).toBe(total === undefined || total === suma);
        expect(JSON.stringify(cambiarDestino(m, "DGNG"))).not.toMatch(sinNumeros);
      }),
      OPCIONES,
    );
  });

  it("R2b-4 · JSON hostil (claves y tipos inesperados, __proto__, la forma de toJSON pasada tal cual) se rechaza con MontoInvalidoError de mensaje fijo, nunca con una fila en cero ni un TypeError (plan Contratos: desdeJSON estricto, clave desconocida → MontoInvalidoError; D5)", () => {
    const mensaje = new MontoInvalidoError().message;
    const comprobar = (nombre: string, f: () => unknown): string | undefined => {
      const e = errorDe(f);
      if (!(e instanceof MontoInvalidoError)) return `${nombre}: ${e === undefined ? "aceptado" : String(e)}`;
      if (e.message !== mensaje || e.message.includes("123.45")) return `${nombre}: mensaje con valores`;
      return undefined;
    };
    const money = [
      '{"monto":"123.45","moneda":"PEN","extra":"x"}', '{"monto":123.45,"moneda":"PEN"}',
      '{"monto":"123.45","moneda":"pen"}', '{"monto":"123.45","moneda":["PEN"]}',
      '{"monto":["123.45"],"moneda":"PEN"}', '{"monto":{"monto":"123.45","moneda":"PEN"},"moneda":"PEN"}',
      '{"monto":"123.45","__proto__":{"moneda":"PEN"}}', '{"__proto__":{"monto":"123.45","moneda":"PEN"}}',
      '{"monto":"123.45","moneda":"PEN","__proto__":null}', '{"monto":"123.455","moneda":"PEN"}',
      '{"monto":"1.2345e2","moneda":"PEN"}', '{"monto":null,"moneda":"PEN"}', '{"monto":"123.45","moneda":null}',
      '{"monto":"123.45","moneda":"EUR"}', '{"moneda":"PEN","total":"123.45","columnas":{}}',
      '[{"monto":"123.45","moneda":"PEN"}]', "null", '"123.45"', "123.45", "true", "{}",
    ];
    const filas = [
      '{"moneda":"PEN","total":"123.45","columnas":{"biDg":"123.45"}}',
      '{"total":"123.45","__proto__":{"biDg":"123.45"}}', '{"total":"123.45","biDg":123.45}',
      '{"total":123.45}', '{"total":"123.45","biDg":null}', '{"total":"123.45","biDg":"123,45"}',
      '{"total":"123.45","BiDg":"123.45"}', '{"total":"123.45","constructor":"123.45"}',
      '{"total":"123.45","hasOwnProperty":"123.45"}', '{"total":"123.45","toString":"123.45"}',
      '{"biDg":"123.45"}', '{"total":"123.45","biDg":"123.45","moneda":"PEN"}',
      '{"total":"123.45","biDg":{"monto":"123.45","moneda":"PEN"}}', '{"total":["123.45"]}',
      '{"total":"123.45","igvDg":"-0.001"}', "[]", "null", '"123.45"',
    ];
    const fallos: Array<string | undefined> = [
      ...money.map((j) => comprobar(`Money.desdeJSON ${j}`, () => Money.desdeJSON(JSON.parse(j)))),
      ...filas.map((j) => comprobar(`MontosComprobante.desde ${j}`, () => MontosComprobante.desde("PEN", JSON.parse(j)))),
      comprobar("total solo heredado", () => MontosComprobante.desde("PEN", Object.create({ total: "123.45" }))),
      ...(["EUR", "pen", "", null, ["PEN"], new String("PEN"), undefined] as unknown[]).map((mo) =>
        comprobar(`moneda ${String(mo)}`, () => MontosComprobante.desde(mo as Moneda, { total: "123.45" })),
      ),
    ];
    expect(fallos.filter((x) => x !== undefined)).toEqual([]);
    // La forma válida mínima sí se acepta (control).
    expect(MontosComprobante.desde("USD", JSON.parse('{"total":"123.45","isc":"123.45"}')).toJSON().columnas.isc).toBe("123.45");
  });

  it("R2b-5 · mezclar monedas en suma, cuadre, movimientos, IGV y conversión lanza MonedaDistintaError y cada resultado conserva su moneda (CA-7, D7)", () => {
    const fp = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const fu = MontosComprobante.desde("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const cuadrable = (moneda: string, total: Money, comps: Money[]): Cuadrable =>
      ({ moneda, total, componentes: () => comps }) as unknown as Cuadrable;
    const mezclas: Array<[string, () => unknown]> = [
      ["sumar", () => pen("1.00").sumar(usd("1.00"))],
      ["restar", () => pen("1.00").restar(usd("1.00"))],
      ["comparar", () => pen("1.00").comparar(usd("1.00"))],
      ["igual", () => pen("0.00").igual(usd("0.00"))],
      ["suma mezclada", () => Money.suma([pen("1.00"), usd("1.00")], "PEN")],
      ["suma USD declarada PEN", () => Money.suma([usd("1.00")], "PEN")],
      ["fila.sumar", () => fp.sumar(fu)],
      ["moverMonto USD en PEN", () => moverMonto(fp, "biDg", "isc", usd("1.00"))],
      ["moverMonto PEN en USD", () => moverMonto(fu, "biDg", "isc", pen("1.00"))],
      ["igvCuadra mezclado", () => igvCuadra(pen("100.00"), usd("18.00"), TASA_IGV_18)],
      ["cuadre total USD en fila PEN", () => verificarCuadre(cuadrable("PEN", usd("1.00"), [pen("1.00")]), TOLERANCIA_CUADRE)],
      ["cuadre componentes USD en fila PEN", () => verificarCuadre(cuadrable("PEN", pen("1.00"), [usd("1.00")]), TOLERANCIA_CUADRE)],
      ["convertirAPen de PEN", () => convertirAPen(fp, TipoCambio.desde("3.3"))],
    ];
    const malos = mezclas
      .map(([n, f]) => [n, errorDe(f)] as const)
      .filter(([, e]) => !(e instanceof MonedaDistintaError))
      .map(([n, e]) => `${n}: ${String(e)}`);
    expect(malos).toEqual([]);
    expect(errorDe(() => verificarCuadre(cuadrable("EUR", pen("1.00"), []), TOLERANCIA_CUADRE))).toBeInstanceOf(DineroError);

    expect(Money.suma([], "USD").moneda).toBe("USD");
    expect(igvEsperado(usd("8.97"), TASA_IGV_18).moneda).toBe("USD");
    expect(redondearSunat(usd("0.15").por(TipoCambio.desde("3.3"))).moneda).toBe("USD");
    const cd = cambiarDestino(fu, "DGNG").montos;
    expect(cd.componentes().every((x) => x.moneda === "USD") && cd.total.moneda === "USD").toBe(true);
    const mv = moverMonto(fu, "biDg", "noGravado", usd("12.51"));
    expect(mv.componentes().every((x) => x.moneda === "USD")).toBe(true);
    const cv = convertirAPen(fu, TipoCambio.desde("3.305"));
    expect(cv.moneda).toBe("PEN");
    expect(cv.componentes().every((x) => x.moneda === "PEN") && cv.total.moneda === "PEN").toBe(true);
    expect(verificarCuadre(cv, TOLERANCIA_CUADRE).cuadra).toBe(true);
    const r = verificarCuadre(fu, TOLERANCIA_CUADRE);
    expect([r.total.moneda, r.sumaComponentes.moneda, r.diferencia.moneda]).toEqual(["USD", "USD", "USD"]);
  });

  it("R2b-6 · verificarCuadre no da por cuadrada una fila cuyo total no es un Money real (plan Contratos: Cuadrable.total: Money; D2)", () => {
    const comps = [pen("100.00"), pen("18.00")];
    const totalFalso = {
      moneda: "PEN",
      restar: () => Money.cero("PEN"),
      toString: () => "999.00",
      toJSON: () => ({ monto: "999.00", moneda: "PEN" }),
    };
    const fila = { moneda: "PEN", total: totalFalso, componentes: () => comps } as unknown as Cuadrable;
    let resultado: unknown = undefined;
    const e = errorDe(() => {
      resultado = verificarCuadre(fila, TOLERANCIA_CUADRE);
    });
    expect.soft(resultado, "verificarCuadre aceptó un total que no es Money").toBeUndefined();
    expect.soft(e).toBeInstanceOf(DineroError);
    // Componentes que no son Money sí se rechazan (control).
    const filaComps = { moneda: "PEN", total: pen("1.00"), componentes: () => [{ moneda: "PEN" }] } as unknown as Cuadrable;
    expect(errorDe(() => verificarCuadre(filaComps, TOLERANCIA_CUADRE))).toBeInstanceOf(DineroError);
  });

  it("R2b-7 · Tolerancia en sus límites: gramática estricta, |diferencia| = tol cuadra y tol + 0.01 no, en ambos signos; TOLERANCIA_* valen 0.00 y 0.01 (D2, plan Contratos Tolerancia ≥ 0, ≤ 2 decimales)", () => {
    for (const s of ["0", "0.0", "0.00", "0.01", "0.1", "999999999999.99"]) {
      expect(Tolerancia.desde(s)).toBeInstanceOf(Tolerancia);
    }
    const invalidas: unknown[] = [
      "-0", "-0.00", "-0.01", "0.001", "0.005", "1e-2", ".01", "01", "00.01", "", " 0.01", "0.01 ", "0,01",
      "+0.01", "1000000000000.00", "Infinity", "NaN", "٠.٠١", 0.01, 0, null, undefined, {}, ["0.01"],
    ];
    const aceptadas = invalidas.filter((s) => !(errorDe(() => Tolerancia.desde(s as string)) instanceof DineroError));
    expect(aceptadas).toEqual([]);

    const fila = (dif: bigint): MontosComprobante =>
      MontosComprobante.desde("PEN", { biDg: "500000000000.00", igvDg: "-500000000000.00", isc: "123.45", total: aTexto(12345n + dif) });
    // total y diferencia dentro de NUMERIC(14,2) (una diferencia fuera de rango es R2b-8).
    const enRango = (dif: bigint): boolean =>
      [12345n + dif, dif].every((x) => x <= 99999999999999n && x >= -99999999999999n);
    for (const t of [0n, 1n, 5n, 100n, 99999999999999n]) {
      const tol = Tolerancia.desde(aTexto(t));
      for (const signo of [1n, -1n]) {
        if (enRango(signo * t)) expect(verificarCuadre(fila(signo * t), tol).cuadra).toBe(true);
        if (enRango(signo * (t + 1n))) expect(verificarCuadre(fila(signo * (t + 1n)), tol).cuadra).toBe(false);
      }
    }
    expect(verificarCuadre(fila(1n), TOLERANCIA_CUADRE).cuadra).toBe(false);
    expect(verificarCuadre(fila(-1n), TOLERANCIA_CUADRE).cuadra).toBe(false);
    expect(verificarCuadre(fila(0n), TOLERANCIA_CUADRE).diferencia.toString()).toBe("0.00");
    // TOLERANCIA_IGV = 0.01: 100.00 × 18 % = 18.00; 17.99/18.01 cuadran, 17.98/18.02 no (también con signo).
    for (const [b, i, ok] of [
      ["100.00", "18.01", true], ["100.00", "17.99", true], ["100.00", "18.02", false], ["100.00", "17.98", false],
      ["-100.00", "-18.01", true], ["-100.00", "-18.02", false],
    ] as const) {
      expect(igvCuadra(pen(b), pen(i), TASA_IGV_18)).toBe(ok);
      expect(igvCuadra(pen(b), pen(i), TASA_IGV_18, TOLERANCIA_IGV)).toBe(ok);
      expect(igvCuadra(pen(b), pen(i), TASA_IGV_18, TOLERANCIA_CUADRE)).toBe(false);
    }
    expect(igvCuadra(pen("100.00"), pen("10.00"), TASA_IGV_10, TOLERANCIA_CUADRE)).toBe(true);
    expect(igvCuadra(pen("100.00"), pen("18.00"), TASA_IGV_10)).toBe(false);
  });

  it("R2b-8 · con montos válidos cuya diferencia excede NUMERIC(14,2), igvCuadra responde false y convertirAPen lanza el error de cuadre, no MontoFueraDeRangoError (D2, D3; decisión del usuario opción A de R1b-5: error de cuadre antes que cualquier error de rango)", () => {
    const max = "999999999999.99";
    const min = "-999999999999.99";
    const casosIgv: Array<[string, string, TasaIgv]> = [
      [max, min, TASA_IGV_18],
      [min, max, TASA_IGV_10],
      ["500000000000.00", min, TASA_IGV_18],
    ];
    for (const [b, i, t] of casosIgv) {
      let r: unknown = "lanzó";
      const e = errorDe(() => {
        r = igvCuadra(pen(b), pen(i), t);
      });
      expect.soft(r, `igvCuadra(${b}, ${i}) debe ser false (lanzó ${String(e)})`).toBe(false);
    }
    const desc = MontosComprobante.desde("USD", { biDg: min, total: max });
    expect.soft(errorDe(() => convertirAPen(desc, TipoCambio.desde("3.3")))).toBeInstanceOf(ComprobanteDescuadradoError);
    const desc2 = MontosComprobante.desde("USD", { biDg: "600000000000.00", igvDg: "-600000000000.00", isc: max, total: min });
    expect.soft(errorDe(() => convertirAPen(desc2, TipoCambio.desde("1")))).toBeInstanceOf(ComprobanteDescuadradoError);
    // verificarCuadre debe devolver diferencia: Money; aquí basta con que no diga "cuadra" (CA-3 permite lanzar).
    const salida: { r?: { cuadra: boolean } } = {};
    const ec = errorDe(() => {
      salida.r = verificarCuadre(desc, TOLERANCIA_CUADRE);
    });
    expect(salida.r === undefined ? ec instanceof MontoFueraDeRangoError : salida.r.cuadra === false).toBe(true);
  });

  it("R2b-9 · casos reales con variaciones: oráculo D1 de igvEsperado en 0.00–100.00 (±, 18 % y 10 %, PEN y USD), mixta 21.48/1.61 con el rango exacto 8.92–8.97 en ambos signos e IGV inverso, y San Juan ISC 770 por partes, en negativo y en USD (spec Casos reales, D1, D3, D6, CA-9)", () => {
    // Oráculo independiente con BigInt.
    const malos: string[] = [];
    for (let c = 0n; c <= 10000n; c += 1n) {
      for (const [tasa, t] of [[TASA_IGV_18, 18n], [TASA_IGV_10, 10n]] as const) {
        for (const signo of [1n, -1n]) {
          const moneda: Moneda = c % 2n === 0n ? "PEN" : "USD";
          const obt = igvEsperado(Money.desde(aTexto(signo * c), moneda), tasa).toString();
          const esp = aTexto(igvOraculo(signo * c, t));
          if (obt !== esp) malos.push(`${aTexto(signo * c)}×${t}%: ${obt} ≠ ${esp}`);
        }
      }
    }
    expect(malos.slice(0, 5)).toEqual([]);

    // Mixta: mover k de BI DG a no gravado; con tolerancia 0.00 cuadra ⇔ BI restante ∈ [8.92, 8.97].
    for (const [moneda, s] of [["PEN", 1n], ["USD", 1n], ["PEN", -1n]] as const) {
      const T = (c: bigint) => aTexto(s * c);
      const mixta = MontosComprobante.desde(moneda, { biDg: T(2148n), igvDg: T(161n), total: T(2309n) });
      for (let k = 1230n; k <= 1270n; k += 1n) {
        const r = moverMonto(mixta, "biDg", "noGravado", Money.desde(T(k), moneda));
        const bi = 2148n - k;
        expect(r.total.toString()).toBe(T(2309n));
        expect(verificarCuadre(r, TOLERANCIA_CUADRE).cuadra).toBe(true);
        const exacto = igvCuadra(r.obtener("biDg"), r.obtener("igvDg"), TASA_IGV_18, TOLERANCIA_CUADRE);
        expect(exacto).toBe(bi >= 892n && bi <= 897n);
        const conTol = igvCuadra(r.obtener("biDg"), r.obtener("igvDg"), TASA_IGV_18);
        const dif = 161n - igvOraculo(bi, 18n);
        expect(conTol).toBe(dif >= -1n && dif <= 1n);
      }
    }
    // IGV inverso: base = IGV / 18 % redondeada; los extremos 1.605 y 1.615 caen en 8.92 y 8.97.
    expect(redondearSunat(pen("1.61").entre(TASA_IGV_18)).toString()).toBe("8.94");
    expect(redondearSunat(MontoExacto.desde("1.605", "PEN").entre(TASA_IGV_18)).toString()).toBe("8.92");
    expect(redondearSunat(MontoExacto.desde("1.615", "PEN").entre(TASA_IGV_18)).toString()).toBe("8.97");
    expect(redondearSunat(MontoExacto.desde("-1.615", "PEN").entre(TASA_IGV_18)).toString()).toBe("-8.97");
    expect(redondearSunat(pen("1.61").entre(TASA_IGV_18).por(TASA_IGV_18)).toString()).toBe("1.61");

    // San Juan ISC 770 con variaciones.
    for (const [moneda, s] of [["PEN", 1n], ["USD", 1n], ["PEN", -1n]] as const) {
      const T = (c: bigint) => aTexto(s * c);
      const m = MontosComprobante.desde(moneda, { biDg: T(77000n), igvDg: "0.00", total: T(77000n) });
      const directo = moverMonto(m, "biDg", "isc", Money.desde(T(77000n), moneda));
      const partes = moverMonto(moverMonto(m, "biDg", "isc", Money.desde(T(1n), moneda)), "biDg", "isc", Money.desde(T(76999n), moneda));
      expect(JSON.stringify(partes)).toBe(JSON.stringify(directo));
      expect(directo.obtener("isc").toString()).toBe(T(77000n));
      expect(directo.obtener("biDg").esCero() && directo.obtener("igvDg").esCero()).toBe(true);
      expect(directo.total.toString()).toBe(T(77000n));
      expect(verificarCuadre(directo, TOLERANCIA_CUADRE).cuadra).toBe(true);
      expect(igvCuadra(directo.obtener("biDg"), directo.obtener("igvDg"), TASA_IGV_18, TOLERANCIA_CUADRE)).toBe(true);
      expect(cambiarDestino(directo, "DNG").consolidados).toEqual([]);
      expect(errorDe(() => moverMonto(m, "biDg", "isc", Money.desde(T(77001n), moneda)))).toBeInstanceOf(MovimientoInvalidoError);
      expect(errorDe(() => moverMonto(m, "biDg", "isc", Money.desde(T(-77000n), moneda)))).toBeInstanceOf(MovimientoInvalidoError);
      expect(errorDe(() => moverMonto(directo, "igvDg", "isc", Money.desde(T(1n), moneda)))).toBeInstanceOf(MovimientoInvalidoError);
    }
  });

  it("R2b-10 · rendimiento acotado y resultado exacto con entradas grandes: 10 000 comprobantes en sumar, 100 000 montos en suma y cadenas de 600 por/entre (CA-3, CA-6, D1; plan Riesgos: la fracción exacta crece ~16·n dígitos)", { timeout: 60000 }, () => {
    // Generador determinista (LCG) en BigInt.
    let semilla = 20261025n;
    const sig = (mod: bigint): bigint => {
      semilla = (semilla * 6364136223846793005n + 1442695040888963407n) % 18446744073709551616n;
      return semilla % mod;
    };
    const N = 10000;
    const esperadas = new Map<ColumnaCompra, bigint>(COLUMNAS_COMPRA.map((c) => [c, 0n]));
    let totalEsp = 0n;
    let acumulado = MontosComprobante.desde("PEN", { total: "0.00" });
    for (let i = 0; i < N; i += 1) {
      const v: Partial<Record<ColumnaCompra, string>> & { total: string } = { total: "0.00" };
      let s = 0n;
      for (const c of COLUMNAS_COMPRA) {
        const x = sig(1999998n) - 999999n; // hasta ±9 999.99 por columna
        v[c] = aTexto(x);
        esperadas.set(c, (esperadas.get(c) ?? 0n) + x);
        s += x;
      }
      v.total = aTexto(s);
      totalEsp += s;
      acumulado = acumulado.sumar(MontosComprobante.desde("PEN", v));
    }
    for (const c of COLUMNAS_COMPRA) expect(acumulado.obtener(c).toString()).toBe(aTexto(esperadas.get(c) ?? 0n));
    expect(acumulado.total.toString()).toBe(aTexto(totalEsp));
    expect(verificarCuadre(acumulado, TOLERANCIA_CUADRE).cuadra).toBe(true);

    // 10 000 filas en el borde: 99 999 999.99 × 10 000 = 999 999 999 900.00 cabe; una más desborda.
    const borde = MontosComprobante.desde("PEN", { biDg: "99999999.99", total: "99999999.99" });
    let b = borde;
    for (let i = 1; i < N; i += 1) b = b.sumar(borde);
    expect(b.total.toString()).toBe("999999999900.00");
    expect(errorDe(() => b.sumar(borde))).toBeInstanceOf(MontoFueraDeRangoError);

    // 100 000 montos en Money.suma.
    const lista: Money[] = [];
    let sumaEsp = 0n;
    for (let i = 0; i < 100000; i += 1) {
      const x = sig(2000000000n) - 1000000000n;
      sumaEsp += x;
      lista.push(Money.desde(aTexto(x), "USD"));
    }
    expect(Money.suma(lista, "USD").toString()).toBe(aTexto(sumaEsp));

    // 600 pares por(f)/entre(f) con factores de 10 decimales vuelven exactamente al original.
    const factores: Factor[] = [];
    for (let i = 0; i < 300; i += 1) {
      const f = `${sig(1000000n)}.${sig(10000000000n).toString().padStart(10, "0")}`.replace(/^0+(?=\d)/, "");
      factores.push(Factor.desde(/[1-9]/.test(f) ? f : "1"));
    }
    let x = MontoExacto.desde("-123456789.0123456789", "PEN");
    for (const f of factores) x = x.por(f);
    for (const f of [...factores].reverse()) x = x.entre(f);
    expect(redondearSunat(x).toString()).toBe("-123456789.01");
    expect(x.toString().length).toBeLessThan(80);
    // Divisiones sucesivas por 1e-10 desbordan sin colgarse; productos sucesivos por 1e-10 dan 0.00.
    let grande = pen("0.01").entre(Factor.desde("0.0000000001"));
    let chico = pen("999999999999.99").por(Factor.desde("0.0000000001"));
    for (let i = 0; i < 300; i += 1) {
      grande = grande.entre(Factor.desde("0.0000000001"));
      chico = chico.por(Factor.desde("0.0000000001"));
    }
    expect(errorDe(() => redondearSunat(grande))).toBeInstanceOf(MontoFueraDeRangoError);
    expect(redondearSunat(chico).toString()).toBe("0.00");
  });
});
