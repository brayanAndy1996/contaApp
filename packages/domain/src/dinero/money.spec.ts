import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../index";
import type { Moneda } from "../index";
import {
  DineroError,
  MonedaDistintaError,
  Money,
  MontoFueraDeRangoError,
  MontoInvalidoError,
} from "../index";

// Pruebas de Money contra la API pública (plan 010, Contratos). CA-1, CA-2, CA-3,
// CA-5, CA-6, CA-7 (parte de Money), CA-11 y decisiones D5, D7, D8.

const SEMILLA = 20261025;
const CORRIDAS = 1000;
const MAX = "999999999999.99";
const MIN = "-999999999999.99";

const pen = (s: string): Money => Money.desde(s, "PEN");
const usd = (s: string): Money => Money.desde(s, "USD");

/** Oráculo independiente: céntimos como bigint a partir del string canónico. */
function centimos(s: string): bigint {
  const negativo = s.startsWith("-");
  const [ent, dec = ""] = (negativo ? s.slice(1) : s).split(".");
  const c = BigInt(ent + dec.padEnd(2, "0"));
  return negativo ? -c : c;
}
function formatear(c: bigint): string {
  const negativo = c < 0n;
  const abs = (negativo ? -c : c).toString().padStart(3, "0");
  const texto = `${abs.slice(0, -2)}.${abs.slice(-2)}`;
  return negativo ? `-${texto}` : texto;
}

/** Strings canónicos de exactamente 2 decimales (nunca number convertidos). */
const montoCanonico = (digitosEnteros: number): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom("", "-"),
      fc.stringMatching(
        new RegExp(`^(0|[1-9][0-9]{0,${digitosEnteros - 1}})$`),
      ),
      fc.stringMatching(/^[0-9]{2}$/),
    )
    .map(([signo, ent, dec]) => {
      const s = `${signo}${ent}.${dec}`;
      return s === "-0.00" ? "0.00" : s;
    });

/** Si la API pública aún no exporta algo, TODA prueba falla por esa razón (rojo explícito). */
beforeEach(() => {
  const funciones: Record<string, unknown> = {
    DineroError,
    MonedaDistintaError,
    Money,
    MontoFueraDeRangoError,
    MontoInvalidoError,
  };
  for (const [nombre, valor] of Object.entries(funciones)) {
    expect(valor, `@contapp/domain debe exportar ${nombre}`).toBeTypeOf(
      "function",
    );
  }
  const valores: Record<string, unknown> = {};
  for (const [nombre, valor] of Object.entries(valores)) {
    expect(valor, `@contapp/domain debe exportar ${nombre}`).toBeDefined();
  }
});

describe("CA-1 · aritmética exacta", () => {
  it("0.10 + 0.20 = 0.30 sin error de coma flotante", () => {
    expect(pen("0.10").sumar(pen("0.20")).toString()).toBe("0.30");
  });
  it("restar y negar son exactos", () => {
    expect(pen("0.30").restar(pen("0.10")).toString()).toBe("0.20");
    expect(pen("1.10").negar().toString()).toBe("-1.10");
  });
  it("abs, esNegativo y comparar", () => {
    expect(pen("-5.00").abs().toString()).toBe("5.00");
    expect(pen("-0.01").esNegativo()).toBe(true);
    expect(pen("0.00").esNegativo()).toBe(false);
    expect(pen("-0.01").comparar(pen("0.00"))).toBe(-1);
    expect(pen("5").comparar(pen("5.00"))).toBe(0);
    expect(pen("0.02").comparar(pen("0.01"))).toBe(1);
    expect(pen("5").igual(pen("5.00"))).toBe(true);
    expect(pen("5.01").igual(pen("5.00"))).toBe(false);
  });
  it("conserva la moneda en cada operación", () => {
    expect(usd("1.00").sumar(usd("2.00")).moneda).toBe("USD");
    expect(usd("1.00").negar().moneda).toBe("USD");
    expect(Money.cero("USD").moneda).toBe("USD");
    expect(Money.cero("PEN").toString()).toBe("0.00");
  });
  it("`${a}` funciona; a + b, a < b y +a lanzan (Symbol.toPrimitive)", () => {
    const a = pen("0.10");
    const b = pen("0.20");
    expect(`${a}`).toBe("0.10");
    expect(String(a)).toBe("0.10");
    expect(() => (a as unknown as number) + (b as unknown as number)).toThrow();
    expect(() => (a as unknown as number) < (b as unknown as number)).toThrow();
    expect(() => +(a as unknown as string)).toThrow();
  });
});

describe("CA-2 · entrada estricta (D5, D8)", () => {
  const rechazos: Array<[string, unknown]> = [
    ["number 12.5", 12.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["number 0", 0],
    ["bigint", 10n],
    ["notación científica 1e3", "1e3"],
    ["notación científica 1E-2", "1E-2"],
    ["3 decimales", "12.345"],
    ["coma de miles", "1,234.50"],
    ["coma decimal", "12,50"],
    ["espacio inicial", " 12.00"],
    ["espacio final", "12.00 "],
    ["vacío", ""],
    ["doble signo", "--1"],
    ["hexadecimal", "0x10"],
    ["null", null],
    ["undefined", undefined],
    ["new String", new String("1.00")],
    ["objeto con toString", { toString: () => "1.00" }],
    ["arreglo", ["1.00"]],
    ["signo +", "+1"],
    ["ceros a la izquierda", "01.00"],
    ["sin parte entera", ".5"],
    ["sin decimales tras el punto", "5."],
    ["solo signo", "-"],
    ["solo punto", "."],
    ["dígitos árabes", "١٢.٣٤"],
    ["dígitos fullwidth", "１２.００"],
    ["NBSP inicial", " 12.00"],
    ["NBSP final", "12.00 "],
    ["salto de línea final", "12.00\n"],
    ["string larguísimo", "9".repeat(1000)],
  ];

  it.each(rechazos)(
    "Money.desde rechaza %s con MontoInvalidoError",
    (_n, valor) => {
      expect(() => Money.desde(valor as unknown as string, "PEN")).toThrow(
        MontoInvalidoError,
      );
    },
  );
  it.each(rechazos)(
    "Money.desdeNumeric rechaza %s con MontoInvalidoError",
    (_n, valor) => {
      expect(() =>
        Money.desdeNumeric(valor as unknown as string, "PEN"),
      ).toThrow(MontoInvalidoError);
    },
  );
  it("desdeNumeric rechaza el NaN de PostgreSQL", () => {
    expect(() => Money.desdeNumeric("NaN", "PEN")).toThrow(MontoInvalidoError);
  });

  it("no redondea ni recorta en silencio", () => {
    expect(() => pen("0.005")).toThrow(MontoInvalidoError);
    expect(() => pen("1.999")).toThrow(MontoInvalidoError);
  });

  it("el mensaje es fijo y no incluye el valor recibido", () => {
    let error: unknown;
    try {
      Money.desde("7654321.123", "PEN");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MontoInvalidoError);
    expect((error as Error).message).not.toContain("7654321.123");
    expect((error as Error).message).not.toContain("7654321");
  });
});

describe("CA-3 · rango NUMERIC(14,2)", () => {
  it("el máximo y el mínimo son válidos", () => {
    expect(pen(MAX).toString()).toBe(MAX);
    expect(pen(MIN).toString()).toBe(MIN);
  });
  it("999999999999.99 + 0.01 lanza MontoFueraDeRangoError", () => {
    expect(() => pen(MAX).sumar(pen("0.01"))).toThrow(MontoFueraDeRangoError);
  });
  it("-999999999999.99 - 0.01 lanza MontoFueraDeRangoError", () => {
    expect(() => pen(MIN).restar(pen("0.01"))).toThrow(MontoFueraDeRangoError);
    expect(() => pen(MIN).sumar(pen("-0.01"))).toThrow(MontoFueraDeRangoError);
  });
  it("restar sin salirse del rango es válido en los extremos", () => {
    expect(pen(MAX).restar(pen("0.01")).toString()).toBe("999999999999.98");
    expect(pen(MAX).sumar(pen("-0.01")).toString()).toBe("999999999999.98");
    expect(pen(MIN).sumar(pen("0.01")).toString()).toBe("-999999999999.98");
  });
  it("el rango es simétrico: negar el mínimo da el máximo", () => {
    expect(pen(MIN).negar().toString()).toBe(MAX);
    expect(pen(MAX).negar().toString()).toBe(MIN);
    expect(pen(MIN).abs().toString()).toBe(MAX);
  });
  it("suma(lista) fuera de rango lanza MontoFueraDeRangoError", () => {
    expect(() => Money.suma([pen(MAX), pen("0.01")], "PEN")).toThrow(
      MontoFueraDeRangoError,
    );
  });
  it("MontoFueraDeRangoError y MontoInvalidoError son DineroError distintos", () => {
    const capturar = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return undefined;
    };
    const fuera = capturar(() => pen(MAX).sumar(pen("0.01")));
    const invalido = capturar(() => pen("1e3"));
    expect(fuera).toBeInstanceOf(DineroError);
    expect(invalido).toBeInstanceOf(DineroError);
    expect(fuera).toBeInstanceOf(Error);
    expect(fuera).not.toBeInstanceOf(MontoInvalidoError);
    expect(invalido).not.toBeInstanceOf(MontoFueraDeRangoError);
  });
});

describe("errores del dominio de dinero", () => {
  it("cada error tiene un `codigo` string no vacío y único", () => {
    const capturar = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return undefined;
    };
    const errores = [
      capturar(() => pen("1e3")),
      capturar(() => pen(MAX).sumar(pen("0.01"))),
      capturar(() => pen("1.00").sumar(usd("1.00"))),
    ];
    const codigos = errores.map((e) => (e as { codigo?: unknown }).codigo);
    for (const c of codigos) {
      expect(typeof c).toBe("string");
      expect((c as string).length).toBeGreaterThan(0);
    }
    expect(new Set(codigos).size).toBe(codigos.length);
  });
});

describe("CA-5 · cero sin signo", () => {
  it('Money.desde("-0.00") y "-0" dan "0.00"', () => {
    expect(pen("-0.00").toString()).toBe("0.00");
    expect(pen("-0").toString()).toBe("0.00");
    expect(pen("-0.0").toString()).toBe("0.00");
  });
  it('negar("0.00") da "0.00"', () => {
    expect(pen("0.00").negar().toString()).toBe("0.00");
  });
  it('"0.01" - "0.01" da "0.00"', () => {
    expect(pen("0.01").restar(pen("0.01")).toString()).toBe("0.00");
    expect(pen("-0.01").sumar(pen("0.01")).toString()).toBe("0.00");
  });
  it("son iguales a cero, esCero() verdadero y no negativos", () => {
    for (const m of [
      pen("-0.00"),
      pen("0.00").negar(),
      pen("0.01").restar(pen("0.01")),
      pen("-0.01").abs().restar(pen("0.01")),
    ]) {
      expect(m.esCero()).toBe(true);
      expect(m.igual(Money.cero("PEN"))).toBe(true);
      expect(m.comparar(Money.cero("PEN"))).toBe(0);
      expect(m.esNegativo()).toBe(false);
      expect(m.toString()).toBe("0.00");
      expect(JSON.stringify(m)).not.toContain("-0");
    }
    expect(pen("0.01").esCero()).toBe(false);
  });
});

describe("CA-6 · suma conmutativa y asociativa (fast-check, semilla fija)", () => {
  const lista = fc.array(montoCanonico(6), { minLength: 0, maxLength: 30 });
  const opciones = { seed: SEMILLA, numRuns: CORRIDAS };

  it("suma coincide con el oráculo en bigint (negativos incluidos)", () => {
    fc.assert(
      fc.property(lista, (montos) => {
        const esperado = formatear(
          montos.reduce((acc, s) => acc + centimos(s), 0n),
        );
        expect(Money.suma(montos.map(pen), "PEN").toString()).toBe(esperado);
      }),
      opciones,
    );
  });

  it("cualquier permutación da el mismo resultado", () => {
    fc.assert(
      fc.property(
        lista.chain((l) =>
          fc.tuple(
            fc.constant(l),
            fc.shuffledSubarray(l, {
              minLength: l.length,
              maxLength: l.length,
            }),
          ),
        ),
        ([original, permutada]) => {
          expect(Money.suma(permutada.map(pen), "PEN").toString()).toBe(
            Money.suma(original.map(pen), "PEN").toString(),
          );
        },
      ),
      opciones,
    );
  });

  it("cualquier agrupación da el mismo resultado", () => {
    fc.assert(
      fc.property(lista, fc.nat(30), (montos, corte) => {
        const k = Math.min(corte, montos.length);
        const izq = Money.suma(montos.slice(0, k).map(pen), "PEN");
        const der = Money.suma(montos.slice(k).map(pen), "PEN");
        expect(Money.suma([izq, der], "PEN").toString()).toBe(
          Money.suma(montos.map(pen), "PEN").toString(),
        );
        expect(izq.sumar(der).toString()).toBe(der.sumar(izq).toString());
      }),
      opciones,
    );
  });

  it("suma de lista vacía es 0.00 en la moneda pedida", () => {
    expect(Money.suma([], "PEN").toString()).toBe("0.00");
    expect(Money.suma([], "USD").moneda).toBe("USD");
  });
});

describe("CA-7 (Money) · monedas distintas (D7)", () => {
  it("sumar, restar y comparar entre PEN y USD lanzan MonedaDistintaError", () => {
    expect(() => pen("1.00").sumar(usd("1.00"))).toThrow(MonedaDistintaError);
    expect(() => usd("1.00").restar(pen("1.00"))).toThrow(MonedaDistintaError);
    expect(() => pen("1.00").comparar(usd("1.00"))).toThrow(
      MonedaDistintaError,
    );
  });
  it("suma(lista, moneda) con un elemento de otra moneda lanza MonedaDistintaError", () => {
    expect(() => Money.suma([pen("1.00"), usd("1.00")], "PEN")).toThrow(
      MonedaDistintaError,
    );
    expect(() => Money.suma([usd("1.00")], "PEN")).toThrow(MonedaDistintaError);
  });
  it("MonedaDistintaError es DineroError", () => {
    expect(() => pen("1.00").sumar(usd("1.00"))).toThrow(DineroError);
  });
});

describe("CA-11 · ida y vuelta de NUMERIC", () => {
  const normalizado = (s: string): string => {
    const [ent, dec = ""] = s.split(".");
    const r = `${ent}.${dec.padEnd(2, "0")}`;
    return r === "-0.00" ? "0.00" : r;
  };
  const cualquierValido = fc
    .tuple(
      fc.constantFrom("", "-"),
      fc.stringMatching(/^(0|[1-9][0-9]{0,11})$/),
      fc
        .constantFrom(0, 1, 2)
        .chain((n) =>
          n === 0
            ? fc.constant("")
            : fc
                .stringMatching(new RegExp(`^[0-9]{${n}}$`))
                .map((d) => `.${d}`),
        ),
    )
    .map(([signo, ent, dec]) => `${signo}${ent}${dec}`);

  it("desdeNumeric(s).toString() es s normalizado y cumple la expresión canónica", () => {
    fc.assert(
      fc.property(cualquierValido, (s) => {
        const texto = Money.desdeNumeric(s, "PEN").toString();
        expect(texto).toBe(normalizado(s));
        expect(texto).toMatch(/^-?\d{1,12}\.\d{2}$/);
        expect(texto).not.toBe("-0.00");
        expect(Money.desdeNumeric(texto, "PEN").toString()).toBe(texto);
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    );
  });
  it("ejemplos: 5 → 5.00 y 5.5 → 5.50", () => {
    expect(Money.desdeNumeric("5", "PEN").toString()).toBe("5.00");
    expect(Money.desdeNumeric("5.5", "PEN").toString()).toBe("5.50");
    expect(Money.desdeNumeric("-5.5", "PEN").toString()).toBe("-5.50");
    expect(Money.desdeNumeric("0", "PEN").toString()).toBe("0.00");
  });
  it("desde y desdeNumeric comparten gramática y rango", () => {
    expect(Money.desde("5.5", "PEN").toString()).toBe("5.50");
    expect(Money.desdeNumeric(MAX, "PEN").toString()).toBe(MAX);
    expect(Money.desdeNumeric(MIN, "PEN").toString()).toBe(MIN);
  });
});

describe("serialización JSON", () => {
  it("JSON.stringify produce strings, nunca number", () => {
    const json = JSON.stringify(pen("0.30"));
    expect(json).toBe('{"monto":"0.30","moneda":"PEN"}');
    expect(JSON.stringify({ a: usd("1.5") })).toBe(
      '{"a":{"monto":"1.50","moneda":"USD"}}',
    );
    const parseado = JSON.parse(json) as { monto: unknown; moneda: unknown };
    expect(typeof parseado.monto).toBe("string");
  });
  it("toJSON devuelve { monto, moneda }", () => {
    expect(pen("-12.30").toJSON()).toEqual({ monto: "-12.30", moneda: "PEN" });
  });
  it("desdeJSON(JSON.parse(JSON.stringify(m))) es idéntico", () => {
    fc.assert(
      fc.property(
        montoCanonico(12),
        fc.constantFrom<Moneda[]>("PEN", "USD"),
        (s, moneda) => {
          const m = Money.desde(s, moneda);
          const vuelta = Money.desdeJSON(JSON.parse(JSON.stringify(m)));
          expect(vuelta.toString()).toBe(m.toString());
          expect(vuelta.moneda).toBe(m.moneda);
          expect(vuelta.igual(m)).toBe(true);
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    );
  });
  const jsonInvalidos: Array<[string, unknown]> = [
    ["monto number", { monto: 1.5, moneda: "PEN" }],
    ["sin moneda", { monto: "1.50" }],
    ["sin monto", { moneda: "PEN" }],
    ["clave extra", { monto: "1.50", moneda: "PEN", extra: "x" }],
    ["moneda desconocida", { monto: "1.50", moneda: "EUR" }],
    ["monto con 3 decimales", { monto: "1.505", moneda: "PEN" }],
    ["null", null],
    ["string", "1.50"],
    ["number", 1.5],
    ["arreglo", []],
    ["undefined", undefined],
  ];
  it.each(jsonInvalidos)("desdeJSON rechaza %s con DineroError", (_n, j) => {
    expect(() => Money.desdeJSON(j)).toThrow(DineroError);
  });
  it("desdeJSON con monto no canónico lanza MontoInvalidoError", () => {
    expect(() => Money.desdeJSON({ monto: "1.505", moneda: "PEN" })).toThrow(
      MontoInvalidoError,
    );
    expect(() => Money.desdeJSON({ monto: 1.5, moneda: "PEN" })).toThrow(
      MontoInvalidoError,
    );
  });
});

describe("inmutabilidad y encapsulamiento", () => {
  it("Money está congelado (Object.isFrozen) y no admite asignaciones", () => {
    const m = pen("1.00");
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as unknown as { moneda: string }).moneda = "USD";
    }).toThrow(TypeError);
    expect(() => {
      (m as unknown as { otro: string }).otro = "x";
    }).toThrow(TypeError);
    expect(m.moneda).toBe("PEN");
  });
  it("cada operación devuelve un Money congelado y no altera el original", () => {
    const a = pen("1.00");
    const b = pen("2.00");
    const r = a.sumar(b);
    expect(Object.isFrozen(r)).toBe(true);
    expect(a.toString()).toBe("1.00");
    expect(b.toString()).toBe("2.00");
    expect(Object.isFrozen(a.negar())).toBe(true);
    expect(Object.isFrozen(Money.cero("PEN"))).toBe(true);
    expect(Object.isFrozen(Money.suma([a, b], "PEN"))).toBe(true);
  });
  it("las propiedades propias no exponen objetos (ningún Decimal)", () => {
    for (const v of Object.values(pen("1.00"))) {
      expect(typeof v).toBe("string");
    }
  });
  it("el paquete no exporta el constructor Decimal ni su configuración", () => {
    const exportados = Object.keys(api);
    expect(exportados).not.toContain("Decimal");
    expect(exportados).not.toContain("D");
    expect((api as Record<string, unknown>).Decimal).toBeUndefined();
  });
});
