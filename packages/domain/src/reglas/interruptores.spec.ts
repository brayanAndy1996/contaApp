// Interruptores por estudio (spec 021, RF-089, P-8; CA-8): evaluarReglas con `reglasApagadas`. Rojo (T7).
import { describe, expect, it } from "vitest";
import { ctx, evaluar, fila, montos, ser, xml } from "../../tests/ayudas/filas-motor";
import { EntradaReglasInvalidaError } from "./index";
import type { CodigoRegla, CodigoReglaMotor, FilaEvaluable } from "./index";

const NUEVO = { tipo: "6", numero: "20999999999" };
const COM = (numero: string) => ({ tipo: "01", serie: "F001", numero });

/** Una fila por regla de 011: cada una dispara exactamente la suya. */
const filas = (): FilaEvaluable[] => [
  fila({ id: "isc", comprobante: COM("1"), montos: montos("PEN", { biDg: "770.00", total: "770.00" }) }),
  fila({ id: "mix", comprobante: COM("2"), montos: montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" }) }),
  fila({ id: "red", comprobante: COM("3"), montos: montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" }) }),
  fila({ id: "new", comprobante: COM("4"), proveedor: NUEVO }),
  fila({
    id: "gp",
    comprobante: COM("5"),
    xml: xml({ comprobante: COM("5"), glosas: ["ZAPATILLAS URBANAS T-42"] }),
  }),
];
const CODIGOS_011: readonly CodigoRegla[] = ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP"];
const FILA_DE: Record<CodigoRegla, string> = { "R-ISC": "isc", "R-MIX": "mix", "R-RED": "red", "R-NEW": "new", "R-GP": "gp" };

const reglas = (apagadas?: readonly CodigoReglaMotor[]) =>
  evaluar(filas(), apagadas === undefined ? ctx() : ctx({ reglasApagadas: apagadas })).hallazgos.map((h) => `${h.filaId}:${h.regla}`);

describe("reglasApagadas (CA-8)", () => {
  it("línea base: sin apagadas salen las cinco reglas de 011, una por fila", () => {
    expect(reglas()).toEqual(["gp:R-GP", "isc:R-ISC", "mix:R-MIX", "new:R-NEW", "red:R-RED"]);
  });

  it("lista vacía = sin apagadas", () => {
    expect(reglas([])).toEqual(reglas());
  });

  it.each(CODIGOS_011)("apagar %s: no sale su hallazgo y los demás sí", (codigo) => {
    const esperado = reglas().filter((h) => h !== `${FILA_DE[codigo]}:${codigo}`);
    expect(esperado).toHaveLength(4);
    expect(reglas([codigo])).toEqual(esperado);
  });

  it("apagar varias a la vez: solo quedan las encendidas", () => {
    expect(reglas(["R-ISC", "R-NEW", "R-GP"])).toEqual(["mix:R-MIX", "red:R-RED"]);
  });

  it("apagar todas las de 011: ningún hallazgo", () => {
    expect(reglas(CODIGOS_011)).toEqual([]);
  });

  it("R-HIS apagado es un código válido y no afecta a las reglas de 011", () => {
    expect(reglas(["R-HIS"])).toEqual(reglas());
  });

  it("un código repetido no cambia nada", () => {
    expect(reglas(["R-ISC", "R-ISC"])).toEqual(reglas(["R-ISC"]));
  });

  it("apagar una regla no cambia los avisos de XML ni el orden de salida", () => {
    const ajeno = fila({ id: "ajeno", comprobante: COM("9"), xml: xml({ comprobante: COM("8") }) });
    const a = evaluar([ajeno, ...filas()], ctx({ reglasApagadas: ["R-GP"] }));
    const b = evaluar([ajeno, ...filas()], ctx());
    expect(ser(a.avisos)).toBe(ser(b.avisos));
    expect(b.avisos.map((x) => x.codigo)).toEqual(["XML_AJENO"]);
    expect(ser(a.hallazgos)).toBe(ser(b.hallazgos.filter((h) => h.regla !== "R-GP")));
  });

  it("no muta el contexto recibido", () => {
    const apagadas: CodigoReglaMotor[] = ["R-ISC"];
    const c = ctx({ reglasApagadas: apagadas });
    evaluar(filas(), c);
    expect(apagadas).toEqual(["R-ISC"]);
    expect(c.reglasApagadas).toBe(apagadas);
  });
});

describe("reglasApagadas inválidas (EntradaReglasInvalidaError)", () => {
  const apagadas = (v: unknown) => () => evaluar(filas(), ctx({ reglasApagadas: v as readonly CodigoReglaMotor[] }));

  it("un código desconocido es entrada inválida, mientras que uno válido se acepta", () => {
    expect(apagadas(["R-ISC"])).not.toThrow();
    expect(apagadas(["R-XXX"])).toThrow(EntradaReglasInvalidaError);
    expect(apagadas(["R-ISC", "R-XXX"])).toThrow(EntradaReglasInvalidaError);
  });

  it("la prevalidación de 012 no se puede apagar", () => {
    expect(apagadas(["R-ISC"])).not.toThrow();
    for (const codigo of ["PREVALIDACION", "prevalidacion", "prevalidación", "R-PRE", ""]) {
      expect(apagadas([codigo])).toThrow(EntradaReglasInvalidaError);
    }
  });

  it("un código con otra caja o con espacios es desconocido (sin normalización)", () => {
    expect(apagadas(["R-ISC"])).not.toThrow();
    expect(apagadas(["r-isc"])).toThrow(EntradaReglasInvalidaError);
    expect(apagadas([" R-ISC"])).toThrow(EntradaReglasInvalidaError);
  });

  it("lo que no es un arreglo de textos es inválido", () => {
    expect(apagadas(["R-ISC"])).not.toThrow();
    for (const v of ["R-ISC", 1, null, {}, [1], [null], [["R-ISC"]]]) {
      expect(apagadas(v)).toThrow(EntradaReglasInvalidaError);
    }
  });

  it("valida antes de evaluar: no hay resultados parciales con un código inválido", () => {
    expect(apagadas(["R-NEW", "R-XXX"])).toThrow(EntradaReglasInvalidaError);
  });
});
