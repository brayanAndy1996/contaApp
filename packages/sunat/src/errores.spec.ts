import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ErrorCredencial,
  ErrorDatos,
  ErrorPortal,
  ErrorSunat,
  ErrorTransitorio,
  clasificarError,
} from "./errores.js";

// Contrato (plan 008, packages/sunat/src/errores.ts), CA-8, CA-9, CA-16:
//  - ErrorSunat (base, extiende Error) con `codigo` fijo por subclase. El codigo es el MOTIVO del
//    trabajo cuando el error agota el flujo:
//      ErrorTransitorio -> "sunat_no_responde"   ErrorCredencial -> "credencial_invalida"
//      ErrorDatos       -> "datos_invalidos"     ErrorPortal     -> "portal_cambio"
//  - Constructor: `new ErrorX(causa?: unknown)`. La causa (error crudo del adaptador, respuesta,
//    datos de entrada) se DESCARTA o queda no enumerable: nunca aparece en `message`, `String(e)`,
//    `JSON.stringify(e)`, `e.stack` ni `util.inspect(e)`.
//  - `message` fijo por clase (no vacio). `name` = nombre de la clase. `instanceof` correcto.
//  - clasificarError(e: unknown) -> { clase: "transitorio"|"credencial"|"datos"|"portal", motivo }:
//    un error no clasificado (Error comun, string, null, undefined, objeto) cuenta como
//    TRANSITORIO con motivo "sunat_no_responde" (CA-8). Nunca lanza.
const CANARIO = "CANARIO-SOL-clave-1234 CANARIO-SECRET-xyz CANARIO-TOKEN-abc";

const CLASES = [
  [ErrorTransitorio, "sunat_no_responde", "ErrorTransitorio"],
  [ErrorCredencial, "credencial_invalida", "ErrorCredencial"],
  [ErrorDatos, "datos_invalidos", "ErrorDatos"],
  [ErrorPortal, "portal_cambio", "ErrorPortal"],
] as const;

describe.each(CLASES)("%o", (Clase, codigo, nombre) => {
  it(`tiene codigo fijo ${codigo}, nombre y herencia`, () => {
    const e = new Clase();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ErrorSunat);
    expect(e).toBeInstanceOf(Clase);
    expect(e.codigo).toBe(codigo);
    expect(e.name).toBe(nombre);
    expect(e.message.length).toBeGreaterThan(0);
  });

  it("el codigo no cambia aunque se construya con otra causa", () => {
    expect(new Clase(new Error("otro")).codigo).toBe(codigo);
    expect(new Clase("texto").codigo).toBe(codigo);
  });

  it("el message no incluye la causa ni datos de entrada (canario)", () => {
    for (const causa of [
      CANARIO,
      new Error(CANARIO),
      { claveSol: CANARIO },
      [CANARIO],
    ]) {
      const e = new Clase(causa);
      expect(e.message).not.toContain("CANARIO");
      expect(String(e)).not.toContain("CANARIO");
      expect(JSON.stringify(e)).not.toContain("CANARIO");
      expect(String(e.stack)).not.toContain("CANARIO");
      expect(inspect(e, { depth: 5 })).not.toContain("CANARIO");
    }
  });

  it("el message es el mismo con y sin causa (no depende de la entrada)", () => {
    expect(new Clase(CANARIO).message).toBe(new Clase().message);
  });
});

describe("las cuatro clases son distintas", () => {
  it("ninguna es subclase de otra (la clasificacion no se confunde)", () => {
    const todas = CLASES.map(([C]) => C);
    for (const A of todas) {
      for (const B of todas) {
        if (A !== B) expect(new A()).not.toBeInstanceOf(B);
      }
    }
  });
});

describe("clasificarError", () => {
  it.each([
    [new ErrorTransitorio(), "transitorio", "sunat_no_responde"],
    [new ErrorCredencial(), "credencial", "credencial_invalida"],
    [new ErrorDatos(), "datos", "datos_invalidos"],
    [new ErrorPortal(), "portal", "portal_cambio"],
  ] as const)("%o -> %s / %s", (e, clase, motivo) => {
    expect(clasificarError(e)).toEqual({ clase, motivo });
  });

  it("un error no clasificado cuenta como transitorio (CA-8)", () => {
    const esperado = { clase: "transitorio", motivo: "sunat_no_responde" };
    for (const e of [
      new Error("boom"),
      new TypeError("x"),
      "texto",
      42,
      null,
      undefined,
      {},
      { codigo: "credencial_invalida" },
      Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }),
    ]) {
      expect(clasificarError(e), String(e)).toEqual(esperado);
    }
  });

  it("el motivo devuelto nunca contiene el mensaje del error original", () => {
    const r = clasificarError(new Error(CANARIO));
    expect(JSON.stringify(r)).not.toContain("CANARIO");
  });
});
