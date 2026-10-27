// T13a · Ronda adversarial 2a (regresión), spec 010. Reintenta por otra vía cada hallazgo
// corregido en T12 (R1b-2, R1b-3, R1b-5 opción A, R1b-6). R1b-7 (lint) va en
// tests/limites/dominio-r2a.adv.spec.ts. Cada prueba afirma el comportamiento seguro que exige
// un CA o una D (citado en el nombre); el oráculo de montos es aritmética racional con bigint.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COLUMNAS_COMPRA,
  ComprobanteDescuadradoError,
  Factor,
  FactorInvalidoError,
  Money,
  MontoExacto,
  MontoFueraDeRangoError,
  MontosComprobante,
  TASA_IGV_18,
  TOLERANCIA_CUADRE,
  TipoCambio,
  Tolerancia,
  cambiarDestino,
  convertirAPen,
  igvCuadra,
  moverMonto,
  redondearSunat,
  verificarCuadre,
} from "./index";
import type { ColumnaCompra, Moneda } from "./index";

const SEMILLA = 20261026;
const LIMITE_CENTIMOS = 99999999999999n; // 999 999 999 999.99 (NUMERIC(14,2), CA-3)

// ---------- oráculo racional ----------
function aTexto(centimos: bigint): string {
  const neg = centimos < 0n;
  const a = neg ? -centimos : centimos;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}
/** "12.345" → [12345n, 1000n]. */
function fraccion(s: string): readonly [bigint, bigint] {
  const [e, f = ""] = s.split(".");
  return [BigInt(`${e}${f}`), 10n ** BigInt(f.length)];
}
/** D1: half-up alejándose de cero a céntimos del cociente n/d (d > 0). */
function redondearOraculo(n: bigint, d: bigint): bigint {
  const neg = n < 0n;
  const a = (neg ? -n : n) * 100n;
  let q = a / d;
  if (2n * (a % d) >= d) q += 1n;
  return neg ? -q : q;
}

type Op = { readonly tipo: "por" | "porTc" | "entre"; readonly s: string };

/** Aplica la cadena con la API pública y con el oráculo; devuelve [Money | error, céntimos esperados]. */
function ejecutar(centimos: bigint, moneda: Moneda, ops: readonly Op[]) {
  let n = centimos;
  let d = 100n;
  let x: Money | MontoExacto = Money.desde(aTexto(centimos), moneda);
  for (const op of ops) {
    const [p, q] = fraccion(op.s);
    if (op.tipo === "entre") {
      x = x.entre(Factor.desde(op.s));
      n *= q;
      d *= p;
    } else {
      x = x.por(op.tipo === "por" ? Factor.desde(op.s) : TipoCambio.desde(op.s));
      n *= p;
      d *= q;
    }
  }
  if (x instanceof Money) throw new Error("la cadena necesita al menos una operación");
  return { exacto: x, esperado: redondearOraculo(n, d) };
}

function comprobarCadena(centimos: bigint, moneda: Moneda, ops: readonly Op[]): void {
  const { exacto, esperado } = ejecutar(centimos, moneda, ops);
  if (esperado > LIMITE_CENTIMOS || esperado < -LIMITE_CENTIMOS) {
    expect(() => redondearSunat(exacto)).toThrow(MontoFueraDeRangoError);
    return;
  }
  const r = redondearSunat(exacto);
  expect(r.toString()).toBe(aTexto(esperado));
  expect(r.moneda).toBe(moneda);
}

// ---------- arbitrarios ----------
const FACTORES_NOTABLES = [
  "0.18", "0.1", "0.5", "1.5", "3", "7", "0.7", "0.495", "3.3", "18.15", "16.5",
  "0.0000000001", "999999.9999999999", "1.0000000001", "0.9999999999", "123456.7890123457",
];
const arbFactorLibre = fc
  .tuple(fc.bigInt({ min: 0n, max: 999999n }), fc.integer({ min: 0, max: 10 }), fc.bigInt({ min: 0n, max: 9999999999n }))
  .map(([e, k, f]) => (k === 0 ? `${e}` : `${e}.${(f % 10n ** BigInt(k)).toString().padStart(k, "0")}`));
const arbFactor = fc.oneof(fc.constantFrom(...FACTORES_NOTABLES), arbFactorLibre);
const arbFactorNoCero = arbFactor.filter((s) => /[1-9]/.test(s));
const arbTc = fc
  .tuple(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 999 }))
  .map(([e, k, f]) => (k === 0 ? `${e}` : `${e}.${(f % 10 ** k).toString().padStart(k, "0")}`))
  .filter((s) => /[1-9]/.test(s));
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  arbFactor.map((s) => ({ tipo: "por" as const, s })),
  arbTc.map((s) => ({ tipo: "porTc" as const, s })),
  arbFactorNoCero.map((s) => ({ tipo: "entre" as const, s })),
);
const arbCentimos = fc.oneof(
  fc.bigInt({ min: -100000n, max: 100000n }),
  fc.bigInt({ min: -LIMITE_CENTIMOS, max: LIMITE_CENTIMOS }),
);

/** Ejecuta cada intento y devuelve los que NO lanzaron (vías abiertas). */
function noLanzan(intentos: ReadonlyArray<readonly [string, () => unknown]>): string[] {
  const abiertas: string[] = [];
  for (const [nombre, f] of intentos) {
    try {
      const r = f();
      abiertas.push(`${nombre} → ${describir(r)}`);
    } catch {
      // vía cerrada
    }
  }
  return abiertas;
}
function describir(r: unknown): string {
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}

describe("T13a · ronda adversarial 2a (regresión de T12)", () => {
  // R1b-2 por otra vía: cadenas aleatorias por/porTc/entre en ambos signos, con Factor y TipoCambio,
  // contra un oráculo racional exacto; más empates de medio céntimo construidos a mano.
  it("R2a-1 · MontoExacto fracción exacta: cualquier cadena entre/por (Factor y TipoCambio, ambos signos) redondea como el cociente exacto y los empates de medio céntimo suben alejándose de cero (D1, CA-3, CA-4)", () => {
    fc.assert(
      fc.property(arbCentimos, fc.constantFrom<Moneda>("PEN", "USD"), fc.array(arbOp, { minLength: 1, maxLength: 8 }), (c, m, ops) => {
        comprobarCadena(c, m, ops);
        comprobarCadena(-c, m, ops);
      }),
      { seed: SEMILLA, numRuns: 1500 },
    );

    // Empates exactos construidos (valor exacto → esperado), cada uno también con signo negativo.
    const e = (tipo: Op["tipo"], s: string): Op => ({ tipo, s });
    const ida_y_vuelta_3x30: Op[] = Array.from({ length: 30 }, () => [e("entre", "3"), e("por", "3")]).flat();
    const empates: ReadonlyArray<readonly [string, string, readonly Op[], string]> = [
      ["0.01 ÷ 3 ÷ 7 × 10.5 = 0.005", "0.01", [e("entre", "3"), e("entre", "7"), e("por", "10.5")], "0.01"],
      ["0.03 ÷ 0.7 × TC 1.750 = 0.075", "0.03", [e("entre", "0.7"), e("porTc", "1.750")], "0.08"],
      ["0.01 (÷3 ×3)×30 × 0.5 = 0.005", "0.01", [...ida_y_vuelta_3x30, e("por", "0.5")], "0.01"],
      ["2.25 ÷ 0.18 × 0.0324 = 0.405", "2.25", [e("entre", "0.18"), e("por", "0.0324")], "0.41"],
      ["0.01 ÷ 3 × 1.4999999999 (bajo el empate)", "0.01", [e("entre", "3"), e("por", "1.4999999999")], "0.00"],
      ["0.15 ÷ 7 × 7 × TC 3.300 = 0.495", "0.15", [e("entre", "7"), e("por", "7"), e("porTc", "3.300")], "0.50"],
      ["0.15 × TC 3.3 ÷ 9 × 9 = 0.495", "0.15", [e("porTc", "3.3"), e("entre", "9"), e("por", "9")], "0.50"],
      ["0.01 ÷ 0.0000000001 × 0.0000000001 ÷ 2 = 0.005", "0.01", [e("entre", "0.0000000001"), e("por", "0.0000000001"), e("entre", "2")], "0.01"],
      ["999999999999.99 ÷ 3 × 3 (borde)", "999999999999.99", [e("entre", "3"), e("por", "3")], "999999999999.99"],
      ["999999999999.99 ÷ 2 × 2.0000000000 (borde)", "999999999999.99", [e("entre", "2"), e("por", "2.0000000000")], "999999999999.99"],
    ];
    const fallos: string[] = [];
    for (const [nombre, base, ops, esperado] of empates) {
      for (const signo of [1n, -1n]) {
        const [p, q] = fraccion(base);
        const c = (signo * p * 100n) / q;
        let obtenido: string;
        try {
          obtenido = redondearSunat(ejecutar(c, "PEN", ops).exacto).toString();
        } catch (err) {
          obtenido = `lanza ${(err as Error).name}`;
        }
        const quiere = signo < 0n && esperado !== "0.00" ? `-${esperado}` : esperado;
        if (obtenido !== quiere) fallos.push(`${signo < 0n ? "−" : "+"}${nombre}: ${obtenido} ≠ ${quiere}`);
      }
    }
    expect(fallos).toEqual([]);
  });

  // R1b-2, crecimiento: sin reducción por MCD la fracción crece ~16 dígitos por operación. Una cadena
  // larga debe seguir siendo exacta, en tiempo razonable, y fracciones equivalentes deben mostrarse
  // y redondear igual.
  it("R2a-2 · cadenas largas (600 operaciones con factores de 16 dígitos) siguen exactas y en tiempo acotado; fracciones equivalentes muestran y redondean igual (D1, plan Precisión)", () => {
    const ciclo: Op[] = [
      { tipo: "por", s: "123456.7890123457" },
      { tipo: "entre", s: "987654.3210987654" },
      { tipo: "porTc", s: "3.789" },
      { tipo: "entre", s: "3.7890000001" },
      { tipo: "por", s: "0.9999999999" },
      { tipo: "entre", s: "0.1234567891" },
    ];
    const ops = Array.from({ length: 100 }, () => ciclo).flat();
    const t0 = Date.now();
    comprobarCadena(12345678n, "USD", ops);
    comprobarCadena(-12345678n, "USD", ops);
    const { exacto } = ejecutar(1n, "PEN", ops);
    const texto = exacto.toString();
    const ms = Date.now() - t0;
    expect(texto.length).toBeLessThan(80); // toString sigue siendo un texto acotado (40 dígitos)
    expect(texto).toMatch(/^-?\d+(\.\d+)?$/);
    expect(ms, `cadena de ${ops.length} operaciones tardó ${ms.toFixed(0)} ms`).toBeLessThan(3000);

    // Equivalencias: (x ÷ f) × f = x y (x × f) ÷ f = x exactamente; a/b y ka/kb se ven igual.
    fc.assert(
      fc.property(arbCentimos, arbFactorNoCero, (c, f) => {
        const x = Money.desde(aTexto(c), "PEN");
        expect(redondearSunat(x.entre(Factor.desde(f)).por(Factor.desde(f))).toString()).toBe(x.toString());
        const yv = x.por(Factor.desde(f)).entre(Factor.desde(f));
        expect(redondearSunat(yv).toString()).toBe(x.toString());
      }),
      { seed: SEMILLA, numRuns: 500 },
    );
    const tercio = Money.desde("1.00", "PEN").entre(Factor.desde("3"));
    const dosSextos = Money.desde("2.00", "PEN").entre(Factor.desde("6"));
    const tercioLargo = MontoExacto.desde("1", "PEN").por(Factor.desde("7")).entre(Factor.desde("21"));
    expect(dosSextos.toString()).toBe(tercio.toString());
    expect(tercioLargo.toString()).toBe(tercio.toString());
    expect(redondearSunat(tercio.por(Factor.desde("3"))).toString()).toBe("1.00");
  });

  // R1b-3 por otras vías: llaves Symbol adivinadas (Symbol.for, mismo description, well-known),
  // Reflect.construct con otro new.target, subclases; y objetos con el prototipo correcto pero sin
  // estado privado (Object.create, setPrototypeOf, structuredClone, JSON.parse con __proto__, Proxy).
  it("R2a-3 · constructores sellados: ninguna llave adivinable ni subclase crea instancias, no hay Symbol expuesto y ninguna API acepta objetos con el prototipo correcto sin estado privado (CA-2, CA-3, D7)", () => {
    const pen = (s: string) => Money.desde(s, "PEN");
    const reales = {
      Money: pen("1.00"),
      MontoExacto: MontoExacto.desde("1", "PEN"),
      Factor: Factor.desde("0.18"),
      TipoCambio: TipoCambio.desde("3.5"),
      Tolerancia: Tolerancia.desde("0.01"),
      MontosComprobante: MontosComprobante.desde("PEN", { biDg: "1.00", total: "1.00" }),
    } as const;
    type Ctor = new (...a: unknown[]) => object;
    const clases: ReadonlyArray<readonly [string, Ctor, readonly unknown[]]> = [
      ["Money", Money as unknown as Ctor, [{}, "PEN"]],
      ["MontoExacto", MontoExacto as unknown as Ctor, [{}, {}, "PEN"]],
      ["Factor", Factor as unknown as Ctor, [{}]],
      ["TipoCambio", TipoCambio as unknown as Ctor, [{}]],
      ["Tolerancia", Tolerancia as unknown as Ctor, [{}]],
      ["MontosComprobante", MontosComprobante as unknown as Ctor, ["PEN", {}, pen("0.00")]],
    ];
    const intentos: Array<readonly [string, () => unknown]> = [];
    for (const [nombre, C, resto] of clases) {
      const llaves: ReadonlyArray<readonly [string, symbol]> = [
        ["Symbol.for", Symbol.for(nombre)],
        ["Symbol(desc)", Symbol(nombre)],
        ["Symbol.iterator", Symbol.iterator],
        ["Symbol.toPrimitive", Symbol.toPrimitive],
      ];
      for (const [n, k] of llaves) {
        intentos.push([`${nombre} · Reflect.construct ${n}`, () => Reflect.construct(C, [k, ...resto])]);
        intentos.push([`${nombre} · new.target ajeno ${n}`, () => Reflect.construct(C, [k, ...resto], class {})]);
        intentos.push([
          `${nombre} · subclase ${n}`,
          () => {
            class S extends C {
              constructor() {
                super(k, ...resto);
              }
            }
            return new S();
          },
        ]);
      }
      // Ningún Symbol propio (salvo los bien conocidos) en la clase, el prototipo o una instancia.
      const real = reales[nombre as keyof typeof reales];
      for (const o of [C, C.prototype, real]) {
        for (const s of Object.getOwnPropertySymbols(o)) {
          expect([Symbol.toPrimitive, Symbol.hasInstance], `${nombre} expone ${String(s)}`).toContain(s);
        }
      }
    }

    // Falsos con el prototipo correcto pero sin estado privado.
    function falsos<T extends object>(proto: object, real: T, extra: Record<string, unknown>): Array<readonly [string, T]> {
      const plano = { ...extra };
      return [
        ["Object.create", Object.create(proto, Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v }]))) as T],
        ["setPrototypeOf", Object.setPrototypeOf({ ...plano }, proto) as T],
        ["structuredClone", (globalThis as unknown as { structuredClone: (x: unknown) => unknown }).structuredClone(real) as T],
        ["JSON.parse __proto__", JSON.parse(`{"__proto__": {"moneda": "PEN"}, "moneda": "PEN"}`) as T],
        ["Proxy", new Proxy(real, { get: (t, k) => (k in extra ? extra[k as string] : Reflect.get(t, k, t)) })],
        ["congelado", Object.freeze(Object.setPrototypeOf({ ...plano }, proto)) as T],
      ];
    }
    const uno = pen("1.00");
    for (const [n, f] of falsos(Money.prototype, reales.Money, { moneda: "PEN" })) {
      intentos.push([`Money falso (${n}) · sumar`, () => uno.sumar(f)]);
      intentos.push([`Money falso (${n}) · restar`, () => uno.restar(f)]);
      intentos.push([`Money falso (${n}) · comparar`, () => uno.comparar(f)]);
      intentos.push([`Money falso (${n}) · Money.suma`, () => Money.suma([uno, f], "PEN")]);
      intentos.push([`Money falso (${n}) · igvCuadra`, () => igvCuadra(f, uno, TASA_IGV_18)]);
      intentos.push([`Money falso (${n}) · toString`, () => Money.prototype.toString.call(f)]);
    }
    for (const [n, f] of falsos(MontoExacto.prototype, reales.MontoExacto, { moneda: "PEN" })) {
      intentos.push([`MontoExacto falso (${n}) · redondearSunat`, () => redondearSunat(f)]);
    }
    for (const [n, f] of falsos(Factor.prototype, reales.Factor, {})) {
      intentos.push([`Factor falso (${n}) · por`, () => uno.por(f)]);
      intentos.push([`Factor falso (${n}) · entre`, () => uno.entre(f)]);
    }
    for (const [n, f] of falsos(TipoCambio.prototype, reales.TipoCambio, {})) {
      intentos.push([`TipoCambio falso (${n}) · por`, () => uno.por(f)]);
      intentos.push([
        `TipoCambio falso (${n}) · convertirAPen`,
        () => convertirAPen(MontosComprobante.desde("USD", { biDg: "1.00", total: "1.00" }), f),
      ]);
    }
    for (const [n, f] of falsos(Tolerancia.prototype, reales.Tolerancia, {})) {
      intentos.push([`Tolerancia falsa (${n}) · verificarCuadre`, () => verificarCuadre(reales.MontosComprobante, f)]);
      intentos.push([`Tolerancia falsa (${n}) · igvCuadra`, () => igvCuadra(uno, uno, TASA_IGV_18, f)]);
    }
    expect(noLanzan(intentos)).toEqual([]);
  });

  // R1b-6 por otras vías: T12 exige `instanceof MontosComprobante`, pero instanceof no prueba que el
  // objeto tenga el estado privado. Falsos que pasan instanceof (prototipo + métodos propios, Proxy de
  // uno real con métodos ligados, congelados) y duck typing puro.
  it("R2a-4 · moverMonto, cambiarDestino, convertirAPen y sumar rechazan cualquier objeto que no sea un MontosComprobante genuino (prototipo con obtener propio, Proxy, congelado, duck typing) (CA-7, D4, D7; R1b-6, opción A de R1b-5)", () => {
    const real = (m: Moneda) => MontosComprobante.desde(m, { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    /** Falsos de moneda `m`: componentes() y total cuadran (118.00) pero obtener() devuelve otra fila. */
    function falsos(m: Moneda): Array<readonly [string, MontosComprobante]> {
      const r = real(m);
      const otra: Moneda = m === "PEN" ? "USD" : "PEN";
      const obtener = (c: ColumnaCompra): Money =>
        c === "biDg"
          ? Money.desde("900.00", m)
          : c === "isc"
            ? Money.desde("1000.00", otra) // columna en otra moneda
            : r.obtener(c);
      const propios = {
        moneda: m,
        total: Money.desde("118.00", m),
        obtener,
        componentes: () => r.componentes(),
      };
      const descriptores = Object.fromEntries(Object.entries(propios).map(([k, v]) => [k, { value: v }]));
      return [
        ["Object.create(prototype) + obtener propio", Object.create(MontosComprobante.prototype, descriptores)],
        ["congelado con prototipo", Object.freeze(Object.create(MontosComprobante.prototype, descriptores))],
        [
          "Proxy de uno real con métodos ligados",
          new Proxy(r, {
            get: (t, k) => {
              if (k === "obtener") return obtener;
              const v = Reflect.get(t, k, t);
              return typeof v === "function" ? v.bind(t) : v;
            },
          }),
        ],
        ["duck typing", { ...propios } as unknown as MontosComprobante],
      ];
    }
    const intentos: Array<readonly [string, () => unknown]> = [];
    for (const [n, f] of falsos("PEN")) {
      intentos.push([`${n} · moverMonto`, () => moverMonto(f, "biDg", "noGravado", Money.desde("10.00", "PEN"))]);
      intentos.push([`${n} · cambiarDestino`, () => cambiarDestino(f, "DNG")]);
      intentos.push([`${n} · sumar`, () => real("PEN").sumar(f)]);
    }
    for (const [n, f] of falsos("USD")) {
      intentos.push([`${n} · convertirAPen`, () => convertirAPen(f, TipoCambio.desde("3.5"))]);
    }
    expect(noLanzan(intentos)).toEqual([]);
  });

  // Opción A de R1b-5 (decisión del usuario 2026-10-26): convertirAPen exige que el USD cuadre
  // (TOLERANCIA_CUADRE, D2) y si no lanza el error de cuadre "antes de cualquier conversión, aunque la
  // fila además se saliera de rango" (T12: "antes que cualquier error de rango"). Variantes nuevas:
  // ±0.01 en el borde del rango, notas de crédito, Σ de componentes que desborda en USD, y filas que
  // cuadran con parciales fuera de rango.
  it("R2a-5 · convertirAPen (opción A de R1b-5): ±0.01 en el borde y en notas de crédito, y Σ USD que desborda, lanzan ComprobanteDescuadradoError; las filas que cuadran convierten y cuadran en PEN (D2, D6, D7, CA-3, CA-13)", () => {
    const usd = (v: Partial<Record<ColumnaCompra, string>> & { total: string }) => MontosComprobante.desde("USD", v);
    const descuadradas: ReadonlyArray<readonly [string, ReturnType<typeof usd>, string]> = [
      ["+0.01", usd({ biDg: "100.00", igvDg: "18.00", total: "118.01" }), "3.500"],
      ["−0.01", usd({ biDg: "100.00", igvDg: "18.00", total: "117.99" }), "3.500"],
      ["NC +0.01", usd({ biDg: "-100.00", igvDg: "-18.00", total: "-117.99" }), "3.500"],
      ["NC −0.01", usd({ biDg: "-100.00", igvDg: "-18.00", total: "-118.01" }), "3.500"],
      ["borde +0.01", usd({ biDg: "999999999999.98", total: "999999999999.99" }), "1"],
      ["borde NC −0.01", usd({ biDg: "-999999999999.98", total: "-999999999999.99" }), "1"],
      ["borde ±0.01 con TC que desborda", usd({ biDg: "999999999999.98", total: "999999999999.99" }), "3.300"],
      ["Σ USD desborda por 0.01", usd({ biDg: "999999999999.99", igvDg: "0.01", total: "999999999999.99" }), "1"],
      ["Σ USD NC desborda por 0.01", usd({ biDg: "-999999999999.99", igvDg: "-0.01", total: "-999999999999.99" }), "1"],
      ["Σ USD desborda (dos columnas al límite)", usd({ biDg: "999999999999.99", igvDg: "999999999999.99", total: "0.00" }), "1"],
    ];
    const mal: string[] = [];
    for (const [n, fila, tc] of descuadradas) {
      try {
        convertirAPen(fila, TipoCambio.desde(tc));
        mal.push(`${n}: no lanza`);
      } catch (e) {
        if (!(e instanceof ComprobanteDescuadradoError)) mal.push(`${n}: lanza ${(e as Error).name}`);
      }
    }
    expect(mal).toEqual([]);

    // Cuadran (Σ = total, aunque un parcial de Σ salga del rango): convierten y cuadran en PEN.
    const nc = convertirAPen(usd({ biDg: "-0.15", igvDg: "-0.03", total: "-0.18" }), TipoCambio.desde("3.300"));
    expect([nc.obtener("biDg"), nc.obtener("igvDg"), nc.total].map(String)).toEqual(["-0.50", "-0.10", "-0.60"]);
    const parciales = convertirAPen(
      usd({ biDg: "999999999999.99", igvDg: "999999999999.99", isc: "-999999999999.99", total: "999999999999.99" }),
      TipoCambio.desde("1"),
    );
    expect(parciales.total.toString()).toBe("999999999999.99");
    expect(verificarCuadre(parciales, TOLERANCIA_CUADRE).cuadra).toBe(true);
    for (const c of COLUMNAS_COMPRA) expect(parciales.obtener(c).moneda).toBe("PEN");
    // Los demás errores de entrada siguen intactos.
    expect(() => MontoExacto.desde("1", "PEN").entre(Factor.desde("0"))).toThrow(FactorInvalidoError);
  });
});
