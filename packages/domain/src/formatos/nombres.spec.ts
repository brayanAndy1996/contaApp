// Spec 012 (T3, rojo): gramática de los nombres de archivo (D7; CA-10 en la parte de nombres).
// Contrato: `validarNombreArchivo(nombre)` es true solo para un nombre que pudo producir el
// `nombre()` de algún formato registrado (hoy: CONTAPP-PROVISIONAL-{RUC11}-{AAAAMM}-RCE.{txt|zip});
// nunca lanza. `formato.nombre({ ruc, periodo })` valida los componentes ANTES de armar el nombre y
// lanza NombreArchivoInvalidoError (RUC de 11 dígitos ASCII; periodo AAAAMM con mes 01-12).
import { describe, expect, it } from "vitest";
import { FormatosError, NombreArchivoInvalidoError, seleccionarFormato, validarNombreArchivo } from "../index";

const F = seleccionarFormato("compras", "202610");
const RUC = "20700000002";
const OK_TXT = `CONTAPP-PROVISIONAL-${RUC}-202610-RCE.txt`;
const OK_ZIP = `CONTAPP-PROVISIONAL-${RUC}-202610-RCE.zip`;

describe("validarNombreArchivo · nombres válidos", () => {
  it("acepta el nombre del TXT y del ZIP del provisional", () => {
    expect(validarNombreArchivo(OK_TXT)).toBe(true);
    expect(validarNombreArchivo(OK_ZIP)).toBe(true);
  });

  it("acepta lo que produce nombre() para cualquier RUC de 11 dígitos y periodo válido", () => {
    const n = F.nombre({ ruc: "10123456789", periodo: "209912" });
    expect(validarNombreArchivo(n.nombreTxt)).toBe(true);
    expect(validarNombreArchivo(n.nombreZip)).toBe(true);
  });
});

describe("validarNombreArchivo · nombres rechazados (devuelve false, no lanza)", () => {
  it.each([
    ["con ../ al inicio", `../${OK_TXT}`],
    ["con ../ en medio", `CONTAPP-PROVISIONAL-../${RUC}-202610-RCE.txt`],
    ["con barra", `a/${OK_TXT}`],
    ["con barra invertida", `a\\${OK_TXT}`],
    ["con ..\\ ", `..\\${OK_TXT}`],
    ["con NUL", `${OK_TXT}\u0000`],
    ["con salto de línea final", `${OK_TXT}\n`],
    ["con retorno de carro", `CONTAPP-PROVISIONAL-${RUC}\r-202610-RCE.txt`],
    ["con tabulación", `${OK_TXT}\t`],
    ["con control C1", `CONTAPP-PROVISIONAL-${RUC}-202610-RCE\u0085.txt`],
    ["con espacio inicial", ` ${OK_TXT}`],
    ["con espacio final", `${OK_TXT} `],
    ["con NBSP", `CONTAPP-PROVISIONAL-${RUC}-202610-RCE\u00a0.txt`],
    ["RUC de 10 dígitos", "CONTAPP-PROVISIONAL-2070000000-202610-RCE.txt"],
    ["RUC de 12 dígitos", "CONTAPP-PROVISIONAL-207000000021-202610-RCE.txt"],
    ["RUC con letras", "CONTAPP-PROVISIONAL-2070000000A-202610-RCE.txt"],
    ["RUC con dígitos no ASCII", "CONTAPP-PROVISIONAL-\u0662\u0660\u0667\u0660\u0660\u0660\u0660\u0660\u0660\u0660\u0662-202610-RCE.txt"],
    ["periodo 202613", `CONTAPP-PROVISIONAL-${RUC}-202613-RCE.txt`],
    ["periodo 202600", `CONTAPP-PROVISIONAL-${RUC}-202600-RCE.txt`],
    ["periodo de 5 dígitos", `CONTAPP-PROVISIONAL-${RUC}-20261-RCE.txt`],
    ["periodo de 7 dígitos", `CONTAPP-PROVISIONAL-${RUC}-2026100-RCE.txt`],
    ["extensión en mayúsculas", `CONTAPP-PROVISIONAL-${RUC}-202610-RCE.TXT`],
    ["doble extensión", `${OK_TXT}.zip`],
    ["extensión ajena", `CONTAPP-PROVISIONAL-${RUC}-202610-RCE.exe`],
    ["prefijo de un formato oficial inexistente", `RCE-${RUC}-202610.txt`],
    ["cadena vacía", ""],
    ["solo la extensión", ".txt"],
  ])("rechaza un nombre %s", (_n, nombre) => {
    expect(validarNombreArchivo(nombre)).toBe(false);
  });

  it("un valor que no es string da false", () => {
    for (const v of [null, undefined, 123, {}, [OK_TXT], { toString: () => OK_TXT }]) {
      expect(validarNombreArchivo(v as unknown as string)).toBe(false);
    }
  });
});

describe("formato.nombre · valida los componentes antes de armar el nombre", () => {
  it.each([
    ["RUC de 10 dígitos", "2070000000", "202610"],
    ["RUC de 12 dígitos", "207000000021", "202610"],
    ["RUC con letras", "2070000000A", "202610"],
    ["RUC con ../", "../../etc/pa", "202610"],
    ["RUC con barra", "2070000/002", "202610"],
    ["RUC con salto de línea", "20700000002\n", "202610"],
    ["RUC con dígitos no ASCII", "\u0662\u0660\u0667\u0660\u0660\u0660\u0660\u0660\u0660\u0660\u0662", "202610"],
    ["RUC vacío", "", "202610"],
    ["periodo 202613", "20700000002", "202613"],
    ["periodo 202600", "20700000002", "202600"],
    ["periodo con guion", "20700000002", "2026-10"],
    ["periodo con ../", "20700000002", "../2610"],
    ["periodo con salto de línea", "20700000002", "202610\n"],
    ["periodo vacío", "20700000002", ""],
  ])("lanza NombreArchivoInvalidoError con %s", (_n, ruc, periodo) => {
    expect(() => F.nombre({ ruc, periodo })).toThrow(NombreArchivoInvalidoError);
  });

  it("componentes que no son string lanzan NombreArchivoInvalidoError", () => {
    expect(() => F.nombre({ ruc: 20700000002 as unknown as string, periodo: "202610" })).toThrow(
      NombreArchivoInvalidoError,
    );
    expect(() => F.nombre({ ruc: RUC, periodo: undefined as unknown as string })).toThrow(NombreArchivoInvalidoError);
    expect(() => F.nombre(null as unknown as { ruc: string; periodo: string })).toThrow(NombreArchivoInvalidoError);
  });

  it("el error es un FormatosError con código estable y mensaje sin los valores", () => {
    let e: unknown;
    try {
      F.nombre({ ruc: "../../secreto", periodo: "202610" });
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(FormatosError);
    expect((e as FormatosError).codigo).toMatch(/^[A-Z_]+$/);
    expect((e as Error).message).not.toContain("secreto");
    expect((e as Error).message).not.toContain("..");
  });
});
