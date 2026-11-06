// Spec 013 (T3, rojo): planificarComplemento(existentes, recibidas) (D16, P-2; CA-11; plan, Contratos: Dominio).
// Genérico por libro (014 lo reutiliza): sin montos, sin IO, sin saber qué campos son. Cada persistidor decide qué `campos`
// comparar (ventas: fecha, moneda, tipo de cambio, documento y los 8 montos; no la razón social).
// Contrato que fija la prueba (T9, `packages/domain/src/complemento/index.ts`):
//   existentes: { clave: string, origen: "sire" | "manual", campos: Record<string, string> }[]
//   recibidas:  { clave: string, campos: Record<string, string> }[]
//   resultado:  { nuevas: string[],                      — claves recibidas que no existen, en el orden en que llegaron
//                 iguales: number,                       — recibidas con clave existente y todos los campos idénticos
//                 distintas: { clave, origenExistente: "sire" | "manual", campos: string[], valoresSire: Record<string,string> }[] }
//   - `distintas` también va en el orden de llegada; los `campos` de una distinta = los nombres que difieren (orden alfabético); `valoresSire` = el valor RECIBIDO de esos campos (si la recibida no trae el campo, no hay valor de ese campo);
//   - un campo presente solo de un lado (falta en el existente o en la recibida) cuenta como diferente;
//   - la comparación es de cadenas exactas ("118.00" ≠ "118.0"): el normalizado de montos es del persistidor, no de aquí;
//   - los valores deben ser cadenas: un número (dinero) lanza TypeError;
//   - lo que SUNAT dejó de traer (existente sin recibida) no genera nada: no se borra ni se informa;
//   - nunca decide actualizar: solo informa. Pura, idempotente y sin mutar las entradas.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NUM_RUNS, SEMILLA } from "../../tests/ayudas/comprobante";
import { planificarComplemento } from "./index";

type Campos = Record<string, string>;
type Existente = { clave: string; origen: "sire" | "manual"; campos: Campos };
type Recibida = { clave: string; campos: Campos };

const venta = (total: string, extra: Campos = {}): Campos => ({ fecha: "2026-10-03", moneda: "PEN", baseGravada: "100.00", igv: "18.00", total, ...extra });
const ex = (clave: string, campos: Campos, origen: "sire" | "manual" = "sire"): Existente => ({ clave, origen, campos });
const rc = (clave: string, campos: Campos): Recibida => ({ clave, campos });

describe("planificarComplemento · casos base", () => {
  it("sin nada: nada que hacer", () => {
    expect(planificarComplemento([], [])).toEqual({ nuevas: [], iguales: 0, distintas: [] });
  });

  it("primera descarga (sin existentes): todas son nuevas, en el orden de llegada", () => {
    const r = planificarComplemento([], [rc("03|B001|292", venta("59.00")), rc("03|B001|290", venta("118.00"))]);
    expect(r).toEqual({ nuevas: ["03|B001|292", "03|B001|290"], iguales: 0, distintas: [] });
  });

  it("repetir con los mismos datos: 0 nuevas, todas iguales (CA-11)", () => {
    const filas = [ex("03|B001|290", venta("118.00")), ex("03|B001|292", venta("59.00"))];
    const r = planificarComplemento(filas, filas.map((f) => rc(f.clave, f.campos)));
    expect(r).toEqual({ nuevas: [], iguales: 2, distintas: [] });
  });

  it("recibidas vacías con existentes: no genera nada (lo que SUNAT dejó de traer no se borra)", () => {
    expect(planificarComplemento([ex("03|B001|290", venta("118.00")), ex("03|B001|291", venta("59.00"), "manual")], [])).toEqual({
      nuevas: [],
      iguales: 0,
      distintas: [],
    });
  });
});

describe("planificarComplemento · distintas (D16)", () => {
  it("la 290 con otro total: distinta, con el campo `total` y el valor del SIRE", () => {
    const r = planificarComplemento([ex("03|B001|290", venta("118.00"))], [rc("03|B001|290", venta("120.00"))]);
    expect(r).toEqual({
      nuevas: [],
      iguales: 0,
      distintas: [{ clave: "03|B001|290", origenExistente: "sire", campos: ["total"], valoresSire: { total: "120.00" } }],
    });
  });

  it("varios campos que difieren: todos, en orden alfabético, y solo esos valores del SIRE", () => {
    const r = planificarComplemento(
      [ex("03|B001|290", venta("118.00"))],
      [rc("03|B001|290", venta("120.00", { igv: "20.00", moneda: "USD", fecha: "2026-10-03" }))],
    );
    expect(r.distintas).toHaveLength(1);
    expect(r.distintas[0]!.campos).toEqual(["igv", "moneda", "total"]);
    expect(r.distintas[0]!.valoresSire).toEqual({ igv: "20.00", moneda: "USD", total: "120.00" });
  });

  it("los valores se comparan como cadenas exactas: «118.0» no es «118.00»", () => {
    const r = planificarComplemento([ex("03|B001|290", venta("118.00"))], [rc("03|B001|290", venta("118.0"))]);
    expect(r.distintas.map((d) => d.campos)).toEqual([["total"]]);
  });

  it("un campo que solo está de un lado cuenta como diferente (en ambos sentidos)", () => {
    const solo = planificarComplemento([ex("k", { a: "1" })], [rc("k", { a: "1", tipoCambio: "3.300" })]);
    expect(solo.distintas).toEqual([{ clave: "k", origenExistente: "sire", campos: ["tipoCambio"], valoresSire: { tipoCambio: "3.300" } }]);
    const falta = planificarComplemento([ex("k", { a: "1", tipoCambio: "3.300" })], [rc("k", { a: "1" })]);
    expect(falta.distintas.map((d) => d.campos)).toEqual([["tipoCambio"]]);
  });

  it("la existente `manual` (la 291 agregada a mano) que el SIRE trae distinta: se informa con origenExistente manual, sin tocarla", () => {
    const r = planificarComplemento([ex("03|B001|291", venta("118.00"), "manual")], [rc("03|B001|291", venta("90.00"))]);
    expect(r.nuevas).toEqual([]);
    expect(r.distintas).toEqual([{ clave: "03|B001|291", origenExistente: "manual", campos: ["total"], valoresSire: { total: "90.00" } }]);
  });

  it("la existente `manual` igual a la del SIRE cuenta como igual (no se duplica ni se informa)", () => {
    const r = planificarComplemento([ex("03|B001|291", venta("118.00"), "manual")], [rc("03|B001|291", venta("118.00"))]);
    expect(r).toEqual({ nuevas: [], iguales: 1, distintas: [] });
  });
});

describe("planificarComplemento · el caso del periodo (CA-11)", () => {
  // Periodo: B001-290 y B001-292 del SIRE y la B001-291 agregada a mano. El SIRE trae ahora la 293 y la 290 con otro total.
  const existentes = [ex("03|B001|290", venta("118.00")), ex("03|B001|291", venta("118.00"), "manual"), ex("03|B001|292", venta("59.00"))];
  const recibidas = [rc("03|B001|290", venta("120.00")), rc("03|B001|292", venta("59.00")), rc("03|B001|293", venta("23.60"))];

  it("agrega solo la 293; la 290 sale como distinta con `total`; la 292 es igual; la 291 manual no aparece", () => {
    const r = planificarComplemento(existentes, recibidas);
    expect(r.nuevas).toEqual(["03|B001|293"]);
    expect(r.iguales).toBe(1);
    expect(r.distintas).toEqual([{ clave: "03|B001|290", origenExistente: "sire", campos: ["total"], valoresSire: { total: "120.00" } }]);
  });

  it("los contadores cuadran: recibidas = nuevas + iguales + distintas (la restricción CHECK de `propuesta`)", () => {
    const r = planificarComplemento(existentes, recibidas);
    expect(r.nuevas.length + r.iguales + r.distintas.length).toBe(recibidas.length);
  });

  it("aplicar el plan y repetir deja 0 nuevas (idempotente): las nuevas pasan a ser existentes iguales", () => {
    const r1 = planificarComplemento(existentes, recibidas);
    const despues: Existente[] = [...existentes, ...recibidas.filter((x) => r1.nuevas.includes(x.clave)).map((x) => ex(x.clave, x.campos))];
    const r2 = planificarComplemento(despues, recibidas);
    expect(r2.nuevas).toEqual([]);
    expect(r2.iguales).toBe(2);
    expect(r2.distintas).toEqual(r1.distintas);
  });
});

describe("planificarComplemento · entradas y pureza", () => {
  it("una clave igual solo en mayúsculas o con ceros no es la misma: la normalización es de claveNormalizada, no de aquí", () => {
    const r = planificarComplemento([ex("03|B001|290", venta("118.00"))], [rc("03|b001|290", venta("118.00"))]);
    expect(r.nuevas).toEqual(["03|b001|290"]);
  });

  it("los valores que no son cadena lanzan TypeError (nunca number para dinero)", () => {
    expect(() => planificarComplemento([], [rc("k", { total: 118 as unknown as string })])).toThrow(TypeError);
    expect(() => planificarComplemento([ex("k", { total: 118 as unknown as string })], [])).toThrow(TypeError);
    expect(() => planificarComplemento([], [rc("k", { total: null as unknown as string })])).toThrow(TypeError);
  });

  it("no muta las entradas (congeladas) ni comparte objetos con el resultado", () => {
    const existentes = Object.freeze([Object.freeze(ex("03|B001|290", Object.freeze(venta("118.00")) as Campos))]);
    const recibidas = Object.freeze([Object.freeze(rc("03|B001|290", Object.freeze(venta("120.00")) as Campos)), Object.freeze(rc("03|B001|293", Object.freeze(venta("5.00")) as Campos))]);
    const antes = JSON.stringify([existentes, recibidas]);
    const r = planificarComplemento(existentes, recibidas);
    expect(JSON.stringify([existentes, recibidas])).toBe(antes);
    expect(r.distintas[0]!.valoresSire).not.toBe(recibidas[0]!.campos);
  });

  it("los campos de la recibida con nombres como __proto__ o constructor no contaminan nada", () => {
    const campos = JSON.parse('{"total":"1.00","__proto__":"x","constructor":"y"}') as Campos;
    const r = planificarComplemento([ex("k", { total: "2.00" })], [rc("k", campos)]);
    expect(r.distintas).toHaveLength(1);
    expect(({} as Record<string, unknown>).total).toBeUndefined();
  });
});

describe("planificarComplemento · propiedades", () => {
  const campo = fc.constantFrom("a", "b", "c", "total");
  const valor = fc.constantFrom("1.00", "2.00", "3.50", "");
  const campos = fc.dictionary(campo, valor);
  const claves = ["k1", "k2", "k3", "k4", "k5", "k6"];

  it("recibidas = nuevas + iguales + distintas; las nuevas no existen; las distintas sí; todo en el orden de llegada", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ clave: fc.constantFrom(...claves), campos }), { maxLength: 6 }),
        fc.shuffledSubarray(claves),
        fc.array(campos, { minLength: 6, maxLength: 6 }),
        (exs, recibidasClaves, camposRecibidos) => {
          const unicas = new Map(exs.map((e) => [e.clave, e]));
          const existentes = [...unicas.values()].map((e) => ex(e.clave, e.campos));
          const recibidas = recibidasClaves.map((k, i) => rc(k, camposRecibidos[i]!));
          const r = planificarComplemento(existentes, recibidas);
          expect(r.nuevas.length + r.iguales + r.distintas.length).toBe(recibidas.length);
          const existentesPorClave = new Map(existentes.map((e) => [e.clave, e]));
          for (const k of r.nuevas) expect(existentesPorClave.has(k)).toBe(false);
          for (const d of r.distintas) {
            expect(existentesPorClave.has(d.clave)).toBe(true);
            expect(d.campos.length).toBeGreaterThan(0);
            // valoresSire lleva el valor recibido de cada campo que difiere (si la recibida no trae el campo, no hay valor).
            const recibida = recibidas.find((x) => x.clave === d.clave)!;
            expect(Object.keys(d.valoresSire).sort()).toEqual(d.campos.filter((c) => Object.hasOwn(recibida.campos, c)).sort());
            for (const [c, v] of Object.entries(d.valoresSire)) expect(v).toBe(recibida.campos[c]);
          }
          expect(r.nuevas).toEqual(recibidasClaves.filter((k) => r.nuevas.includes(k)));
          const claveDistintas = r.distintas.map((d) => d.clave);
          expect(claveDistintas).toEqual(recibidasClaves.filter((k) => claveDistintas.includes(k)));
        },
      ),
      { numRuns: NUM_RUNS, seed: SEMILLA },
    );
  });

  it("idempotencia: aplicar las nuevas y planificar de nuevo no agrega nada y mantiene las mismas distintas", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(claves), fc.shuffledSubarray(claves), fc.array(campos, { minLength: 6, maxLength: 6 }), fc.array(campos, { minLength: 6, maxLength: 6 }), (cEx, cRc, cmpEx, cmpRc) => {
        const existentes = cEx.map((k, i) => ex(k, cmpEx[i]!));
        const recibidas = cRc.map((k, i) => rc(k, cmpRc[i]!));
        const r1 = planificarComplemento(existentes, recibidas);
        const despues = [...existentes, ...recibidas.filter((x) => r1.nuevas.includes(x.clave)).map((x) => ex(x.clave, x.campos))];
        const r2 = planificarComplemento(despues, recibidas);
        expect(r2.nuevas).toEqual([]);
        expect(r2.distintas).toEqual(r1.distintas);
        expect(r2.iguales).toBe(r1.iguales + r1.nuevas.length);
      }),
      { numRuns: NUM_RUNS, seed: SEMILLA },
    );
  });
});
