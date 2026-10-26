// T11b · Ronda adversarial 1b (caja blanca), spec 010. Solo escenarios fuera de la lista de T11a.
// Cada prueba afirma el comportamiento seguro que exige un CA o una D (citado en el nombre).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COLUMNAS_COMPRA,
  DineroError,
  Factor,
  FactorInvalidoError,
  MonedaDistintaError,
  Money,
  MontoFueraDeRangoError,
  MontoInvalidoError,
  MontosComprobante,
  MovimientoInvalidoError,
  TOLERANCIA_CUADRE,
  TipoCambio,
  cambiarDestino,
  convertirAPen,
  moverMonto,
  redondearSunat,
  verificarCuadre,
} from "../index";
import type { ColumnaCompra, Destino, Moneda } from "../index";

const OPCIONES = { seed: 20261025, numRuns: 1000 };
const DESTINOS: readonly Destino[] = ["DG", "DGNG", "DNG"];
const PAR: Record<Destino, readonly [ColumnaCompra, ColumnaCompra]> = {
  DG: ["biDg", "igvDg"],
  DGNG: ["biDgng", "igvDgng"],
  DNG: ["biDng", "igvDng"],
};
const NO_PARES: readonly ColumnaCompra[] = ["noGravado", "isc", "icbper", "otrosTributos"];

function aTexto(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
  return neg && a !== 0n ? `-${s}` : s;
}

/** Fila: 10 columnas (céntimos con signos mezclados, ceros frecuentes) y total libre. */
const arbCentimos = fc.oneof(
  { arbitrary: fc.constant(0n), weight: 1 },
  { arbitrary: fc.bigInt({ min: -100000000000n, max: 100000000000n }), weight: 3 },
);
const arbFila = fc.tuple(fc.array(arbCentimos, { minLength: 10, maxLength: 10 }), arbCentimos);

function crear(moneda: Moneda, [cols, total]: [bigint[], bigint], signo = 1n): MontosComprobante {
  const v: Partial<Record<ColumnaCompra, string>> & { total: string } = {
    total: aTexto(total * signo),
  };
  COLUMNAS_COMPRA.forEach((c, i) => {
    v[c] = aTexto(cols[i] * signo);
  });
  return MontosComprobante.desde(moneda, v);
}

const suma = (m: MontosComprobante) => Money.suma(m.componentes(), m.moneda).toString();
const sumaDe = (m: MontosComprobante, i: 0 | 1) =>
  Money.suma(DESTINOS.map((d) => m.obtener(PAR[d][i])), m.moneda).toString();

/** Fracción canónica en (0, 1] como Factor. */
const arbFraccion = fc
  .bigInt({ min: 1n, max: 10000000000n })
  .map((n) => (n === 10000000000n ? "1" : `0.${n.toString().padStart(10, "0")}`));

const arbOp = fc.oneof(
  fc.record({ tipo: fc.constant("cambiar" as const), d: fc.constantFrom(...DESTINOS) }),
  fc.record({
    tipo: fc.constant("mover" as const),
    origen: fc.constantFrom(...COLUMNAS_COMPRA),
    destino: fc.constantFrom(...COLUMNAS_COMPRA),
    frac: arbFraccion,
  }),
);

describe("T11b · comprobante (ronda 1b)", () => {
  it("R1b-4 · cadenas de cambiarDestino y moverMonto conservan ΣBI, ΣIGV, Σcolumnas, total y moneda, son idempotentes y no mutan; sumar de muchos comprobantes no depende del orden (CA-6, CA-7, CA-8, CA-9, D4, D6)", () => {
    fc.assert(
      fc.property(arbFila, fc.array(arbOp, { minLength: 1, maxLength: 25 }), (fila, ops) => {
        const inicial = crear("PEN", fila);
        const jsonInicial = JSON.stringify(inicial);
        const sumaInicial = suma(inicial);
        let m = inicial;
        for (const op of ops) {
          const antes = m;
          const jsonAntes = JSON.stringify(antes);
          if (op.tipo === "cambiar") {
            const { montos, consolidados } = cambiarDestino(antes, op.d);
            const esperados = DESTINOS.filter(
              (o) => o !== op.d && (!antes.obtener(PAR[o][0]).esCero() || !antes.obtener(PAR[o][1]).esCero()),
            );
            expect(consolidados).toEqual(esperados);
            expect(sumaDe(montos, 0)).toBe(sumaDe(antes, 0));
            expect(sumaDe(montos, 1)).toBe(sumaDe(antes, 1));
            for (const o of DESTINOS) {
              if (o === op.d) continue;
              expect(montos.obtener(PAR[o][0]).esCero() && montos.obtener(PAR[o][1]).esCero()).toBe(true);
            }
            for (const c of NO_PARES) expect(montos.obtener(c).toString()).toBe(antes.obtener(c).toString());
            expect(cambiarDestino(montos, op.d).consolidados).toEqual([]);
            m = montos;
          } else {
            const saldo = antes.obtener(op.origen);
            const monto = saldo.esCero() ? saldo : redondearSunat(saldo.por(Factor.desde(op.frac)));
            if (op.origen === op.destino || saldo.esCero() || monto.esCero()) {
              expect(() => moverMonto(antes, op.origen, op.destino, monto)).toThrow(MovimientoInvalidoError);
              continue;
            }
            const r = moverMonto(antes, op.origen, op.destino, monto);
            expect(r.obtener(op.origen).toString()).toBe(saldo.restar(monto).toString());
            expect(r.obtener(op.destino).toString()).toBe(antes.obtener(op.destino).sumar(monto).toString());
            m = r;
          }
          expect(JSON.stringify(antes)).toBe(jsonAntes);
          expect(Object.isFrozen(m)).toBe(true);
          expect(m.moneda).toBe("PEN");
          expect(m.total.toString()).toBe(antes.total.toString());
          expect(suma(m)).toBe(sumaInicial);
        }
        expect(JSON.stringify(inicial)).toBe(jsonInicial);
      }),
      OPCIONES,
    );

    fc.assert(
      fc.property(
        fc
          .array(arbFila, { minLength: 2, maxLength: 40 })
          .chain((l) => fc.tuple(fc.constant(l), fc.shuffledSubarray(l, { minLength: l.length, maxLength: l.length }))),
        ([lista, permutada]) => {
          const a = lista.map((f) => crear("PEN", f)).reduce((x, y) => x.sumar(y));
          const b = permutada.map((f) => crear("PEN", f)).reduce((x, y) => x.sumar(y));
          const mitad = Math.floor(lista.length / 2);
          const izq = lista.slice(0, mitad).map((f) => crear("PEN", f)).reduce((x, y) => x.sumar(y));
          const der = lista.slice(mitad).map((f) => crear("PEN", f)).reduce((x, y) => x.sumar(y));
          expect(b.toJSON()).toEqual(a.toJSON());
          expect(izq.sumar(der).toJSON()).toEqual(a.toJSON());
          for (const c of COLUMNAS_COMPRA) {
            const esperado = Money.suma(lista.map((f) => crear("PEN", f).obtener(c)), "PEN");
            expect(a.obtener(c).toString()).toBe(esperado.toString());
          }
          expect(Object.isFrozen(a)).toBe(true);
          const conUsd = lista.map((f, i) => crear(i === mitad ? "USD" : "PEN", f));
          expect(() => conUsd.reduce((x, y) => x.sumar(y))).toThrow(MonedaDistintaError);
        },
      ),
      { seed: 20261025, numRuns: 300 },
    );
  });

  // Decisión del usuario (2026-10-26, opción A sobre el hallazgo R1b-5): convertirAPen verifica
  // primero que el comprobante USD cuadre con TOLERANCIA_CUADRE (D2) y, si no, lanza un error de
  // cuadre del dominio (subclase de DineroError, mensaje sin valores) antes de cualquier conversión,
  // aunque la fila además se saliera de rango al convertir. Si cuadra, convierte por componente (D7).
  it("R1b-5 · convertirAPen (opción A): exige que el USD cuadre antes de convertir; si cuadra convierte por componente, cuadra en PEN, |Δ| ≤ 0.05, simétrico con notas de crédito y sin desborde silencioso (D2, D7, CA-3, CA-13, D6)", () => {
    const arbTc = fc
      .tuple(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 999 }))
      .map(([e, largo, f]) => (largo === 0 ? `${e}` : `${e}.${(f % 10 ** largo).toString().padStart(largo, "0")}`))
      .filter((s) => /[1-9]/.test(s));
    const arbColumnas = fc.array(fc.bigInt({ min: -1000000000n, max: 1000000000n }), { minLength: 10, maxLength: 10 });
    const arbDescuadre = fc.oneof(
      fc.constantFrom(1n, -1n),
      fc.bigInt({ min: -1000000000n, max: 1000000000n }).filter((x) => x !== 0n),
    );
    const sumaCols = (cols: bigint[]) => cols.reduce((a, b) => a + b, 0n);

    /** El error de cuadre: DineroError propio (no uno de los existentes) y sin valores en el mensaje. */
    function esperaErrorDeCuadre(f: () => unknown, valores: readonly string[]): void {
      let e: unknown = undefined;
      try {
        f();
      } catch (x) {
        e = x;
      }
      expect(e, "debe lanzar el error de cuadre").toBeInstanceOf(DineroError);
      for (const otro of [MontoFueraDeRangoError, MontoInvalidoError, MonedaDistintaError, FactorInvalidoError, MovimientoInvalidoError]) {
        expect(e, `no debe ser ${otro.name}`).not.toBeInstanceOf(otro);
      }
      const err = e as DineroError;
      expect(typeof err.codigo === "string" && err.codigo.length > 0).toBe(true);
      for (const v of valores) expect(err.message).not.toContain(v);
    }

    // (1) Filas USD que cuadran (total = Σ columnas): convierten por componente sin error.
    fc.assert(
      fc.property(arbColumnas, arbTc, (cols, tcs) => {
        const tc = TipoCambio.desde(tcs);
        const usd = crear("USD", [cols, sumaCols(cols)]);
        expect(verificarCuadre(usd, TOLERANCIA_CUADRE).cuadra).toBe(true);
        const pen = convertirAPen(usd, tc);
        expect(pen.moneda).toBe("PEN");
        for (const c of COLUMNAS_COMPRA) {
          expect(pen.obtener(c).moneda).toBe("PEN");
          expect(pen.obtener(c).toString()).toBe(redondearSunat(usd.obtener(c).por(tc)).toString());
        }
        expect(pen.total.toString()).toBe(suma(pen));
        expect(verificarCuadre(pen, TOLERANCIA_CUADRE).cuadra).toBe(true);
        const directo = Money.desde(redondearSunat(usd.total.por(tc)).toString(), "PEN");
        expect(pen.total.restar(directo).abs().comparar(Money.desde("0.05", "PEN"))).toBeLessThanOrEqual(0);
        const penNeg = convertirAPen(crear("USD", [cols, sumaCols(cols)], -1n), tc);
        for (const c of COLUMNAS_COMPRA) {
          expect(penNeg.obtener(c).toString()).toBe(pen.obtener(c).negar().toString());
        }
        expect(penNeg.total.toString()).toBe(pen.total.negar().toString());
      }),
      OPCIONES,
    );

    // (2) Filas USD que no cuadran (incluso por ±0.01): lanzan el error de cuadre.
    fc.assert(
      fc.property(arbColumnas, arbDescuadre, arbTc, (cols, delta, tcs) => {
        const total = sumaCols(cols) + delta;
        const usd = crear("USD", [cols, total]);
        esperaErrorDeCuadre(() => convertirAPen(usd, TipoCambio.desde(tcs)), [aTexto(total)]);
      }),
      { seed: 20261025, numRuns: 300 },
    );

    const tc = (s: string) => TipoCambio.desde(s);
    const usd = (v: Partial<Record<ColumnaCompra, string>> & { total: string }) => MontosComprobante.desde("USD", v);

    // CA-13 con fila que cuadra.
    const ca13 = convertirAPen(usd({ biDg: "0.15", igvDg: "0.03", total: "0.18" }), tc("3.300"));
    expect([ca13.obtener("biDg"), ca13.obtener("igvDg"), ca13.total].map(String)).toEqual(["0.50", "0.10", "0.60"]);

    // Descuadre del caso de R1b-5 (total 999.00 ≠ Σ 118.00).
    esperaErrorDeCuadre(() => convertirAPen(usd({ biDg: "100.00", igvDg: "18.00", total: "999.00" }), tc("3.500")), [
      "999",
      "118",
      "100.00",
      "18.00",
    ]);

    // El error de cuadre va primero: no cuadra Y además se saldría de rango al convertir.
    esperaErrorDeCuadre(() => convertirAPen(usd({ biDg: "999999999999.99", total: "0.00" }), tc("1.001")), [
      "999999999999",
    ]);
    esperaErrorDeCuadre(() => convertirAPen(usd({ biDg: "-999999999999.99", total: "0.00" }), tc("1.001")), [
      "999999999999",
    ]);

    // (3) Rango con filas que cuadran: por columna y en el total recalculado.
    expect(convertirAPen(usd({ biDg: "999999999999.99", total: "999999999999.99" }), tc("1")).total.toString()).toBe(
      "999999999999.99",
    );
    expect(() => convertirAPen(usd({ biDg: "999999999999.99", total: "999999999999.99" }), tc("1.001"))).toThrow(
      MontoFueraDeRangoError,
    );
    expect(() => convertirAPen(usd({ biDg: "-999999999999.99", total: "-999999999999.99" }), tc("1.001"))).toThrow(
      MontoFueraDeRangoError,
    );
    expect(() =>
      convertirAPen(
        usd({ biDg: "600000000000.00", noGravado: "399999999999.99", total: "999999999999.99" }),
        tc("1.001"),
      ),
    ).toThrow(MontoFueraDeRangoError);

    // Medio céntimo por columna, positivo y negativo, con fila que cuadra (Σ 0.15).
    const chica = convertirAPen(usd({ biDg: "0.01", igvDg: "-0.01", isc: "0.15", total: "0.15" }), tc("0.5"));
    expect([chica.obtener("biDg"), chica.obtener("igvDg"), chica.obtener("isc"), chica.total].map(String)).toEqual([
      "0.01",
      "-0.01",
      "0.08",
      "0.08",
    ]);
  });

  it("R1b-6 · cambiarDestino y moverMonto no lavan objetos que no son MontosComprobante (columnas que no son Money, monedas mezcladas) y el caso sin cambios devuelve una instancia nueva (CA-7, plan: Movimientos e Inmutabilidad)", () => {
    const pen = (s: string) => Money.desde(s, "PEN");
    const hostil = { toString: () => "1e3", esCero: () => false };
    const falsoHostil = Object.freeze({
      moneda: "PEN",
      total: pen("100.00"),
      componentes: () => [],
      obtener: (c: ColumnaCompra) => (c === "biDg" ? pen("100.00") : c === "isc" ? hostil : Money.cero("PEN")),
    }) as unknown as MontosComprobante;
    const falsoMonedas = Object.freeze({
      moneda: "PEN",
      total: pen("100.00"),
      componentes: () => [],
      obtener: (c: ColumnaCompra) =>
        c === "biDg" ? pen("100.00") : c === "isc" ? Money.desde("5.00", "USD") : Money.cero("PEN"),
    }) as unknown as MontosComprobante;

    let r1: unknown = "lanzó";
    try {
      r1 = moverMonto(falsoHostil, "biDg", "noGravado", pen("10.00")).toJSON().columnas.isc;
    } catch {
      /* comportamiento seguro */
    }
    expect.soft(r1, "moverMonto aceptó un objeto falso y copió una columna que no es Money").toBe("lanzó");

    let r2: unknown = "lanzó";
    try {
      r2 = cambiarDestino(falsoHostil, "DNG").montos.toJSON().columnas.isc;
    } catch {
      /* comportamiento seguro */
    }
    expect.soft(r2, "cambiarDestino aceptó un objeto falso y copió una columna que no es Money").toBe("lanzó");

    let r3: unknown = "lanzó";
    try {
      const m = moverMonto(falsoMonedas, "biDg", "noGravado", pen("1.00"));
      r3 = `${m.moneda}/${m.obtener("isc").moneda}`;
    } catch {
      /* comportamiento seguro */
    }
    expect.soft(r3, "moverMonto produjo un MontosComprobante PEN con columnas USD").toBe("lanzó");

    const real = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const sinCambios = cambiarDestino(real, "DG");
    expect(sinCambios.consolidados).toEqual([]);
    expect(sinCambios.montos.toJSON()).toEqual(real.toJSON());
    expect.soft(sinCambios.montos, "plan: sin cambios → nueva instancia congelada").not.toBe(real);
  });
});
