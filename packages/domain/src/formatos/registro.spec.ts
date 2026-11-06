// Spec 012 (T3, rojo): RegistroFormatos.desde y seleccionarFormato (D5, D10; CA-9, RNF-043).
// Contrato: `desde` lanza DefinicionFormatoInvalidaError; `seleccionarFormato(libro, periodo, registro?)`
// elige la versión con `vigenteDesde` <= periodo más reciente (AAAAMM comparado como periodo completo,
// no por mes) y lanza FormatoNoVigenteError si el periodo es anterior a toda versión o no hay libro.
import { describe, expect, it } from "vitest";
import {
  DefinicionFormatoInvalidaError,
  FormatoNoVigenteError,
  FormatosError,
  REGISTRO_FORMATOS,
  RegistroFormatos,
  seleccionarFormato,
} from "../index";
import type { FormatoTxt } from "../index";
import { campoDePrueba, formatoDePrueba } from "../../tests/ayudas/formatos";

function debeSerInvalido(formatos: readonly FormatoTxt[]): void {
  expect(() => RegistroFormatos.desde(formatos)).toThrow(DefinicionFormatoInvalidaError);
}

describe("RegistroFormatos.desde · definiciones válidas", () => {
  it("acepta un formato mínimo y devuelve un registro congelado", () => {
    const r = RegistroFormatos.desde([formatoDePrueba()]);
    expect(r).toBeInstanceOf(RegistroFormatos);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("el mismo id con otra versión, o la misma versión con otro id, es válido", () => {
    expect(() =>
      RegistroFormatos.desde([formatoDePrueba({ version: "1" }), formatoDePrueba({ version: "2", vigenteDesde: "202607" })]),
    ).not.toThrow();
    expect(() =>
      RegistroFormatos.desde([formatoDePrueba({ id: "A" }), formatoDePrueba({ id: "B", vigenteDesde: "202607" })]),
    ).not.toThrow();
  });

  it("copia la entrada: mutar el arreglo o el formato original después no cambia el registro", () => {
    const f = formatoDePrueba({ oficial: false });
    const lista: FormatoTxt[] = [f];
    const r = RegistroFormatos.desde(lista);
    lista.push(formatoDePrueba({ version: "9", vigenteDesde: "203001" }));
    try {
      (f as { oficial: boolean }).oficial = true;
    } catch {
      // Si el registro congeló el original en vez de copiarlo, la asignación lanza: también vale.
    }
    const elegido = seleccionarFormato("compras", "203501", r);
    expect(elegido.version).toBe("1");
    expect(elegido.oficial).toBe(false);
  });

  it("los formatos del registro salen congelados, con sus campos", () => {
    const r = RegistroFormatos.desde([formatoDePrueba()]);
    const f = seleccionarFormato("compras", "202601", r);
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.campos)).toBe(true);
    expect(f.campos.every((c) => Object.isFrozen(c))).toBe(true);
  });
});

describe("RegistroFormatos.desde · definiciones inválidas (DefinicionFormatoInvalidaError)", () => {
  it("rechaza id y versión repetidos", () => {
    debeSerInvalido([formatoDePrueba(), formatoDePrueba({ vigenteDesde: "202607" })]);
  });

  it.each([
    ["con guion", "2026-01"],
    ["de 5 dígitos", "20261"],
    ["de 7 dígitos", "2026010"],
    ["mes 13", "202613"],
    ["mes 00", "202600"],
    ["vacío", ""],
    ["con espacio inicial", " 202601"],
    ["con salto de línea final", "202601\n"],
    ["con letras", "2026AB"],
    ["con dígitos no ASCII", "\u0662\u0660\u0662\u0666\u0660\u0661"],
  ])("rechaza un vigenteDesde %s", (_n, v) => {
    debeSerInvalido([formatoDePrueba({ vigenteDesde: v })]);
  });

  it("rechaza un vigenteDesde que no es string", () => {
    debeSerInvalido([formatoDePrueba({ vigenteDesde: 202601 as unknown as string })]);
    debeSerInvalido([formatoDePrueba({ vigenteDesde: null as unknown as string })]);
  });

  it.each([
    ["vacío", ""],
    ["de dos caracteres", "||"],
    ["salto de línea", "\n"],
    ["retorno de carro", "\r"],
    ["tabulación", "\t"],
    ["NUL", "\u0000"],
    ["NBSP", "\u00a0"],
  ])("rechaza un separador %s", (_n, sep) => {
    debeSerInvalido([formatoDePrueba({ separador: sep })]);
  });

  it("rechaza un campo cuyo patrón admite el separador (el separador no puede estar en el conjunto de caracteres del campo)", () => {
    debeSerInvalido([
      formatoDePrueba({
        separador: "|",
        campos: [campoDePrueba({ nombre: "a", patron: /^[A-Z|]+$/ })],
      }),
    ]);
  });

  it("rechaza un patrón con bandera g o y (RegExp con estado: rompería el determinismo; T6)", () => {
    debeSerInvalido([formatoDePrueba({ campos: [campoDePrueba({ nombre: "a", patron: /^[A-Z]+$/g })] })]);
    debeSerInvalido([formatoDePrueba({ campos: [campoDePrueba({ nombre: "a", patron: /^[A-Z]+$/y })] })]);
  });

  it("rechaza un separador que puede aparecer en un valor no textual: dígito, letra, punto, guion o barra (T6)", () => {
    for (const sep of ["0", "A", ".", "-", "/", " "]) debeSerInvalido([formatoDePrueba({ separador: sep })]);
  });

  it("acepta un campo cuyo patrón no admite el separador", () => {
    expect(() =>
      RegistroFormatos.desde([
        formatoDePrueba({ separador: "|", campos: [campoDePrueba({ nombre: "a", patron: /^[A-Z]+$/ })] }),
      ]),
    ).not.toThrow();
  });

  it("rechaza un campo sin nombre", () => {
    debeSerInvalido([formatoDePrueba({ campos: [campoDePrueba({ nombre: "" })] })]);
    debeSerInvalido([formatoDePrueba({ campos: [campoDePrueba({ nombre: undefined as unknown as string })] })]);
  });

  it("rechaza nombres de campo repetidos, una lista de campos vacía y una longitud máxima no positiva", () => {
    debeSerInvalido([formatoDePrueba({ campos: [campoDePrueba({ nombre: "a" }), campoDePrueba({ nombre: "a" })] })]);
    debeSerInvalido([formatoDePrueba({ campos: [] })]);
    debeSerInvalido([formatoDePrueba({ campos: [campoDePrueba({ nombre: "a", longitudMax: 0 })] })]);
    debeSerInvalido([formatoDePrueba({ campos: [campoDePrueba({ nombre: "a", longitudMax: -1 })] })]);
  });

  it("rechaza una codificación o un fin de línea desconocidos", () => {
    debeSerInvalido([formatoDePrueba({ codificacion: "utf16" as unknown as "utf8" })]);
    debeSerInvalido([formatoDePrueba({ finDeLinea: "\r" as unknown as "\n" })]);
  });

  it("rechaza una entrada que no es un arreglo de formatos", () => {
    expect(() => RegistroFormatos.desde(null as unknown as FormatoTxt[])).toThrow(DefinicionFormatoInvalidaError);
    expect(() => RegistroFormatos.desde({} as unknown as FormatoTxt[])).toThrow(DefinicionFormatoInvalidaError);
    debeSerInvalido([null as unknown as FormatoTxt]);
  });

  it("el error es un FormatosError con código estable y mensaje fijo sin valores", () => {
    let e: unknown;
    try {
      RegistroFormatos.desde([formatoDePrueba({ id: "SECRETO-123", vigenteDesde: "malo" })]);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(FormatosError);
    expect((e as FormatosError).codigo).toMatch(/^[A-Z_]+$/);
    expect((e as Error).message).not.toContain("SECRETO-123");
    expect((e as Error).message).not.toContain("malo");
  });
});

describe("seleccionarFormato · dos versiones (D5, CA-9)", () => {
  // A rige desde 2025-11; B, desde 2026-07 (otro año: el mes solo no basta).
  const A = formatoDePrueba({ version: "A", vigenteDesde: "202511" });
  const B = formatoDePrueba({ version: "B", vigenteDesde: "202607" });
  const registro = RegistroFormatos.desde([A, B]);
  const alReves = RegistroFormatos.desde([B, A]);

  it("un periodo anterior a toda versión lanza FormatoNoVigenteError", () => {
    expect(() => seleccionarFormato("compras", "202510", registro)).toThrow(FormatoNoVigenteError);
    expect(() => seleccionarFormato("compras", "199912", registro)).toThrow(FormatoNoVigenteError);
  });

  it("el borde exacto de cada versión elige esa versión", () => {
    expect(seleccionarFormato("compras", "202511", registro).version).toBe("A");
    expect(seleccionarFormato("compras", "202606", registro).version).toBe("A");
    expect(seleccionarFormato("compras", "202607", registro).version).toBe("B");
  });

  it("un periodo de otro año elige por vigenteDesde completo, no por el mes", () => {
    expect(seleccionarFormato("compras", "202512", registro).version).toBe("A");
    expect(seleccionarFormato("compras", "202701", registro).version).toBe("B");
    expect(seleccionarFormato("compras", "203501", registro).version).toBe("B");
  });

  it("el orden en que se declaran las versiones no cambia la elección", () => {
    for (const p of ["202511", "202606", "202607", "202701", "203001"]) {
      expect(seleccionarFormato("compras", p, alReves).version).toBe(seleccionarFormato("compras", p, registro).version);
    }
    expect(() => seleccionarFormato("compras", "202510", alReves)).toThrow(FormatoNoVigenteError);
  });

  it("un libro sin formatos lanza FormatoNoVigenteError (ventas llega en 013, D15)", () => {
    expect(() => seleccionarFormato("ventas" as unknown as "compras", "202610", registro)).toThrow(
      FormatoNoVigenteError,
    );
  });

  it.each(["2026-10", "202613", "202600", "", "20261", "202610\n"])(
    "un periodo mal formado (%j) lanza un FormatosError",
    (p) => {
      expect(() => seleccionarFormato("compras", p, registro)).toThrow(FormatosError);
    },
  );

  it("un periodo que no es string lanza un FormatosError", () => {
    expect(() => seleccionarFormato("compras", 202610 as unknown as string, registro)).toThrow(FormatosError);
    expect(() => seleccionarFormato("compras", null as unknown as string, registro)).toThrow(FormatosError);
  });

  it("FormatoNoVigenteError tiene código estable y su mensaje no incluye el periodo", () => {
    let e: unknown;
    try {
      seleccionarFormato("compras", "202510", registro);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(FormatosError);
    expect((e as FormatosError).codigo).toMatch(/^[A-Z_]+$/);
    expect((e as Error).message).not.toContain("202510");
  });
});

describe("seleccionarFormato · registro por defecto", () => {
  it("sin registro usa REGISTRO_FORMATOS, que hoy solo tiene el RCE provisional", () => {
    expect(seleccionarFormato("compras", "202610")).toBe(seleccionarFormato("compras", "202610", REGISTRO_FORMATOS));
    expect(seleccionarFormato("compras", "202610").oficial).toBe(false);
  });

  it("el provisional rige desde 202601: 202512 lanza y 202601 elige", () => {
    expect(() => seleccionarFormato("compras", "202512")).toThrow(FormatoNoVigenteError);
    expect(seleccionarFormato("compras", "202601").vigenteDesde).toBe("202601");
  });
});
