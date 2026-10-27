import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COLUMNAS_COMPRA,
  MontosComprobante,
  Money,
  MovimientoInvalidoError,
  TASA_IGV_18,
  Tolerancia,
  cambiarDestino,
  igvCuadra,
  moverMonto,
  verificarCuadre,
} from "../index";
import type { ColumnaCompra, Destino } from "../index";

// Ronda adversarial 1a (T11a, caja negra): cuadre ±0.01, conservación encadenada y mutación.
// Solo API pública (plan 010, Contratos). Cada prueba cita el CA o la D que exige.

const SEMILLA = 20261025;
const CORRIDAS = 1000;

const pen = (s: string): Money => Money.desde(s, "PEN");
const tol = (s: string): Tolerancia => Tolerancia.desde(s);

function centimos(s: string): bigint {
  const neg = s.startsWith("-");
  const [ent, dec = ""] = (neg ? s.slice(1) : s).split(".");
  const c = BigInt(ent + dec.padEnd(2, "0"));
  return neg ? -c : c;
}
function desdeCentimos(c: bigint): string {
  const neg = c < 0n;
  const a = (neg ? -c : c).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${a.slice(0, -2)}.${a.slice(-2)}`;
}
function fila(
  v: Partial<Record<ColumnaCompra, string>>,
  total: string,
): MontosComprobante {
  return MontosComprobante.desde("PEN", { ...v, total });
}

describe("ronda 1a · cuadre con ±0.01", () => {
  it("diferencia con signo total − suma, |diferencia| ≤ tolerancia, en ambos signos (CA-10, D2)", () => {
    const casos: Array<
      [Partial<Record<ColumnaCompra, string>>, string, string, string, boolean]
    > = [
      // [columnas, total, tolerancia, diferencia esperada, cuadra esperado]
      [{ biDg: "100.00", igvDg: "18.00" }, "118.01", "0.00", "0.01", false],
      [{ biDg: "100.00", igvDg: "18.00" }, "117.99", "0.00", "-0.01", false],
      [{ biDg: "100.00", igvDg: "18.00" }, "118.00", "0.00", "0.00", true],
      [{ biDg: "100.00", igvDg: "18.00" }, "118.01", "0.01", "0.01", true],
      [{ biDg: "100.00", igvDg: "18.00" }, "117.99", "0.01", "-0.01", true],
      [{ biDg: "100.00", igvDg: "18.00" }, "118.02", "0.01", "0.02", false],
      // una diferencia negativa grande no puede "cuadrar" por compararse sin valor absoluto
      [{ biDg: "100.00", igvDg: "18.00" }, "117.00", "0.01", "-1.00", false],
      [{ biDg: "100.00", igvDg: "18.00" }, "0.00", "0.01", "-118.00", false],
      // nota de crédito (D6): todo negativo
      [{ biDg: "-100.00", igvDg: "-18.00" }, "-118.01", "0.00", "-0.01", false],
      [{ biDg: "-100.00", igvDg: "-18.00" }, "-117.99", "0.00", "0.01", false],
      [{ biDg: "-100.00", igvDg: "-18.00" }, "-118.00", "0.00", "0.00", true],
      [{ biDg: "-100.00", igvDg: "-18.00" }, "-117.99", "0.01", "0.01", true],
      // cerca del límite de NUMERIC(14,2)
      [{ biDg: "999999999999.98" }, "999999999999.99", "0.00", "0.01", false],
      [
        { biDg: "-999999999999.98" },
        "-999999999999.99",
        "0.00",
        "-0.01",
        false,
      ],
      // cero negativo en la entrada
      [{ biDg: "-0.00" }, "0.00", "0.00", "0.00", true],
    ];
    for (const [cols, total, t, dif, cuadra] of casos) {
      const r = verificarCuadre(fila(cols, total), tol(t));
      expect(
        r.diferencia.toString(),
        `${JSON.stringify(cols)} total ${total}`,
      ).toBe(dif);
      expect(r.cuadra, `${JSON.stringify(cols)} total ${total} tol ${t}`).toBe(
        cuadra,
      );
      expect(r.total.toString()).toBe(desdeCentimos(centimos(total)));
    }

    // D2: ±0.01 de IGV contra base × tasa, en ambos signos; ±0.02 ya no.
    const igv: Array<[string, string, boolean]> = [
      ["100.00", "18.01", true],
      ["100.00", "17.99", true],
      ["100.00", "18.02", false],
      ["100.00", "17.98", false],
      ["-100.00", "-18.01", true],
      ["-100.00", "-17.99", true],
      ["-100.00", "-18.02", false],
      ["-100.00", "-17.98", false],
      ["-100.00", "18.00", false],
      ["100.00", "-18.00", false],
    ];
    for (const [b, i, esperado] of igv) {
      expect(igvCuadra(pen(b), pen(i), TASA_IGV_18), `${b}/${i}`).toBe(
        esperado,
      );
    }
  });
});

describe("ronda 1a · conservación del total encadenada", () => {
  it("cadenas de cambiarDestino y moverMonto conservan Σ columnas, total y moneda; los inválidos lanzan sin alterar (CA-8, CA-9, D4, D6)", () => {
    const destinos: Destino[] = ["DG", "DGNG", "DNG"];
    const pares: Record<Destino, [ColumnaCompra, ColumnaCompra]> = {
      DG: ["biDg", "igvDg"],
      DGNG: ["biDgng", "igvDgng"],
      DNG: ["biDng", "igvDng"],
    };
    const monto = fc.bigInt({ min: 0n, max: 1000000000n }); // hasta 10 000 000.00 por columna
    const filaArb = fc.tuple(
      fc.boolean(),
      fc.array(monto, { minLength: 10, maxLength: 10 }),
    );
    const op = fc.oneof(
      fc.record({
        tipo: fc.constant("destino" as const),
        d: fc.constantFrom(...destinos),
      }),
      fc.record({
        tipo: fc.constant("mover" as const),
        o: fc.constantFrom(...COLUMNAS_COMPRA),
        de: fc.constantFrom(...COLUMNAS_COMPRA),
        k: fc.integer({ min: 0, max: 1001 }), // 1001 = pasarse del saldo por un centavo
      }),
    );
    const suma = (m: MontosComprobante): bigint =>
      COLUMNAS_COMPRA.reduce(
        (a, c) => a + centimos(m.obtener(c).toString()),
        0n,
      );

    fc.assert(
      fc.property(
        filaArb,
        fc.array(op, { maxLength: 12 }),
        ([negativa, vals], ops) => {
          const v: Partial<Record<ColumnaCompra, string>> = {};
          COLUMNAS_COMPRA.forEach((c, i) => {
            const x = vals[i] ?? 0n;
            v[c] = desdeCentimos(negativa ? -x : x);
          });
          const total0 = COLUMNAS_COMPRA.reduce(
            (a, c) => a + centimos(v[c] ?? "0.00"),
            0n,
          );
          let m = fila(v, desdeCentimos(total0));
          const original = JSON.stringify(m);
          const inicial = m;

          for (const o of ops) {
            const antes = JSON.stringify(m);
            if (o.tipo === "destino") {
              const biAntes = destinos.reduce(
                (a, d) => a + centimos(m.obtener(pares[d][0]).toString()),
                0n,
              );
              const igvAntes = destinos.reduce(
                (a, d) => a + centimos(m.obtener(pares[d][1]).toString()),
                0n,
              );
              const r = cambiarDestino(m, o.d);
              const n = r.montos;
              expect(centimos(n.obtener(pares[o.d][0]).toString())).toBe(
                biAntes,
              );
              expect(centimos(n.obtener(pares[o.d][1]).toString())).toBe(
                igvAntes,
              );
              for (const d of destinos)
                if (d !== o.d) {
                  expect(n.obtener(pares[d][0]).toString()).toBe("0.00");
                  expect(n.obtener(pares[d][1]).toString()).toBe("0.00");
                }
              expect(cambiarDestino(n, o.d).consolidados).toEqual([]);
              m = n;
            } else {
              const saldo = centimos(m.obtener(o.o).toString());
              const abs = saldo < 0n ? -saldo : saldo;
              const signo = saldo < 0n ? -1n : 1n;
              let cant = o.k === 1001 ? abs + 1n : (abs * BigInt(o.k)) / 1000n;
              if (cant === 0n && o.k !== 0 && abs > 0n) cant = 1n;
              const valido = o.o !== o.de && cant > 0n && cant <= abs;
              const mv = pen(desdeCentimos(signo * cant));
              if (valido) {
                m = moverMonto(m, o.o, o.de, mv);
              } else {
                expect(() => moverMonto(m, o.o, o.de, mv)).toThrow(
                  MovimientoInvalidoError,
                );
                // y el signo contrario al saldo tampoco es válido (D6)
                if (abs > 0n && o.o !== o.de)
                  expect(() => moverMonto(m, o.o, o.de, mv.negar())).toThrow(
                    MovimientoInvalidoError,
                  );
              }
            }
            if (o.tipo === "mover" && o.o === o.de)
              expect(JSON.stringify(m)).toBe(antes);
            expect(suma(m)).toBe(total0);
            expect(m.total.toString()).toBe(desdeCentimos(total0));
            expect(m.moneda).toBe("PEN");
            expect(verificarCuadre(m, tol("0.00")).cuadra).toBe(true);
          }
          // el original nunca cambió
          expect(JSON.stringify(inicial)).toBe(original);
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    );
  });
});

describe("ronda 1a · mutación del original y de internos", () => {
  it("Money y MontosComprobante son inmutables y no comparten estado mutable (CA-8, plan Inmutabilidad)", () => {
    const entrada: Partial<Record<ColumnaCompra, string>> & { total: string } =
      {
        biDg: "100.00",
        igvDg: "18.00",
        total: "118.00",
      };
    const m = MontosComprobante.desde("PEN", entrada);
    const foto = JSON.stringify(m);

    // mutar el objeto de entrada después de construir no afecta
    entrada.biDg = "999.00";
    entrada.total = "0.00";
    expect(JSON.stringify(m)).toBe(foto);

    // congelados
    expect(Object.isFrozen(m)).toBe(true);
    const a = pen("1.00");
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(m.obtener("biDg"))).toBe(true);
    expect(Object.isFrozen(m.total)).toBe(true);

    // asignar o redefinir propiedades falla (módulos ES en modo estricto) y no cambia nada
    const mm = m as unknown as Record<string, unknown>;
    const am = a as unknown as Record<string, unknown>;
    expect(() => {
      am["moneda"] = "USD";
    }).toThrow(TypeError);
    expect(() => {
      mm["total"] = pen("0.00");
    }).toThrow(TypeError);
    expect(() => {
      mm["nuevo"] = 1;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(a, "moneda", { value: "USD" })).toThrow(
      TypeError,
    );
    expect(() => Object.setPrototypeOf(a, {})).toThrow(TypeError);
    expect(a.moneda).toBe("PEN");
    expect(a.toString()).toBe("1.00");

    // componentes(): arreglo congelado y nuevo en cada llamada
    const c1 = m.componentes() as Money[];
    expect(Object.isFrozen(c1)).toBe(true);
    expect(() => {
      c1[0] = pen("5.00");
    }).toThrow(TypeError);
    expect(() => c1.push(pen("5.00"))).toThrow(TypeError);
    expect(m.componentes()).not.toBe(c1);

    // toJSON: lo que devuelve no es un alias del estado interno
    const j = m.toJSON() as { total: string; columnas: Record<string, string> };
    try {
      j.total = "0.00";
      j.columnas["biDg"] = "0.00";
    } catch {
      // congelado también es aceptable
    }
    expect(JSON.stringify(m)).toBe(foto);
    expect(m.obtener("biDg").toString()).toBe("100.00");

    // las operaciones devuelven instancias nuevas y no tocan el original
    cambiarDestino(m, "DNG");
    moverMonto(m, "biDg", "noGravado", pen("10.00"));
    m.sumar(m);
    a.sumar(pen("1.00"));
    a.negar();
    expect(JSON.stringify(m)).toBe(foto);
    expect(a.toString()).toBe("1.00");
    expect(JSON.stringify(m)).not.toMatch(/:\s*-?\d/); // sin number en el JSON
  });
});
