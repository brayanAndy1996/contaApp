// Spec 013 T18 · pruebas de las correcciones de los lectores de archivos (rojo hasta T19). Valen para el lector de 007b
// con los topes de clientes (`LIMITES`) y con los de ventas (`LIMITES_VENTAS`), porque el defecto está en el código común.
//  - H-013-1: el tope de filas del `.xlsx` se aplica MIENTRAS se lee (en streaming): al pasar el tope se rechaza sin haber
//    validado ni analizado el resto de la hoja. Prueba determinista: tras el tope hay XML malformado; un lector que
//    analiza la hoja entera antes de contar filas diría `archivo_invalido`, el que corta al pasar el tope dice `demasiadas_filas`.
//  - H-013-2: el `.csv` aplica `maxColumnas` como el `.xlsx`: las columnas de más se ignoran y no cuestan (no se normalizan).
import { strFromU8, strToU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CABECERA, comprimir, filaDatos, partesXlsx, rucConPrefijo } from "../../../test/soporte-importacion.js";
import { CABECERA_VENTAS } from "../../../test/soporte-ventas.js";
import { leerCsv, leerCsvTabla } from "./lector-csv.js";
import { leerXlsx, leerXlsxTabla } from "./lector-xlsx.js";
import { columnasDePerfil, type PerfilTabla } from "./tabla.js";
import { ErrorArchivo, LIMITES, LIMITES_VENTAS } from "./tipos.js";

const PERFIL_VENTAS: PerfilTabla<string> = {
  limites: LIMITES_VENTAS,
  columnas: columnasDePerfil([...CABECERA_VENTAS]),
  obligatorias: [...CABECERA_VENTAS].filter((c) => c !== "tipoDocContraparte" && c !== "tipoCambio"),
};

/** Código del `ErrorArchivo` que lanza `fn`, o `null` si lee. Cualquier otro error se propaga. */
function codigo(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof ErrorArchivo)) throw e;
    return e.codigo;
  }
  return null;
}

/** `.xlsx` con la cabecera dada, `relleno` insertado al final de `sheetData`. */
function xlsxConRelleno(cabecera: readonly string[], relleno: string): Uint8Array {
  const partes = partesXlsx([[...cabecera]]);
  const hoja = strFromU8(partes["xl/worksheets/sheet1.xml"]!);
  partes["xl/worksheets/sheet1.xml"] = strToU8(hoja.replace("</sheetData>", `${relleno}</sheetData>`));
  return comprimir(partes);
}

const BASURA = "<<<esto no es xml>>>";

/** Letras de columna de Excel (A..Z, AA..) de un índice desde 0; el soporte de 007b solo llega a la Z. */
const letras = (i: number): string => (i < 26 ? "" : letras(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));

/** `.xlsx` cuya primera fila es la cabecera dada, con más de 26 columnas si hace falta. */
function xlsxConCabecera(cabecera: readonly string[]): Uint8Array {
  const celdas = cabecera.map((c, i) => `<c r="${letras(i)}1" t="inlineStr"><is><t>${c}</t></is></c>`).join("");
  const partes = partesXlsx([["x"]]);
  const hoja = strFromU8(partes["xl/worksheets/sheet1.xml"]!);
  partes["xl/worksheets/sheet1.xml"] = strToU8(hoja.replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData><row r="1">${celdas}</row></sheetData>`));
  return comprimir(partes);
}

describe("H-013-1 · el tope de filas del .xlsx corta mientras se lee", () => {
  it("ventas: la fila 20.002 (cabecera + 20.001 filas) da demasiadas_filas aunque el XML quede malformado más adelante", () => {
    const archivo = xlsxConRelleno(CABECERA_VENTAS, `${"<row/>".repeat(20_001)}${BASURA}`);
    expect(codigo(() => leerXlsxTabla(archivo, PERFIL_VENTAS))).toBe("demasiadas_filas");
  });

  it("clientes (007b): la fila 1.002 da demasiadas_filas aunque el XML quede malformado más adelante", () => {
    const archivo = xlsxConRelleno(CABECERA, `${"<row/>".repeat(1_001)}${BASURA}`);
    expect(codigo(() => leerXlsx(archivo))).toBe("demasiadas_filas");
  });

  it("el tope se cuenta igual con filas con celdas (no solo vacías): 1.001 filas de datos de clientes y XML roto después", () => {
    const fila = `<row><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>`;
    const archivo = xlsxConRelleno(CABECERA, `${fila.repeat(1_001)}${BASURA}`);
    expect(codigo(() => leerXlsx(archivo))).toBe("demasiadas_filas");
  });

  it("caso feliz: justo en el tope (cabecera + 20.000 filas en ventas, 1.000 en clientes) se lee sin error", () => {
    expect(leerXlsxTabla(xlsxConRelleno(CABECERA_VENTAS, "<row/>".repeat(20_000)), PERFIL_VENTAS)).toEqual([]);
    expect(leerXlsx(xlsxConRelleno(CABECERA, "<row/>".repeat(1_000))).filas).toEqual([]);
  });

  it("error: un XML malformado DENTRO del tope sigue siendo archivo_invalido (ventas y clientes)", () => {
    const rota = '<row><c r="A2"></row>'; // `<c>` sin cerrar
    expect(codigo(() => leerXlsxTabla(xlsxConRelleno(CABECERA_VENTAS, rota), PERFIL_VENTAS))).toBe("archivo_invalido");
    expect(codigo(() => leerXlsx(xlsxConRelleno(CABECERA, rota)))).toBe("archivo_invalido");
  });

  it("error: una hoja truncada (sin cerrar `worksheet`) con pocas filas es archivo_invalido, no una lectura parcial", () => {
    const partes = partesXlsx([[...CABECERA], filaDatos({ ruc: rucConPrefijo("20", 1) })]);
    const hoja = strFromU8(partes["xl/worksheets/sheet1.xml"]!);
    partes["xl/worksheets/sheet1.xml"] = strToU8(hoja.replace("</worksheet>", ""));
    expect(codigo(() => leerXlsx(comprimir(partes)))).toBe("archivo_invalido");
  });
});

describe("H-013-2 · el .csv aplica maxColumnas como el .xlsx", () => {
  const relleno = (n: number, prefijo = "extra") => Array.from({ length: n }, (_v, i) => `${prefijo}${i}`);
  const enCsv = (...lineas: string[][]) => strToU8(lineas.map((l) => l.join(",")).join("\r\n") + "\r\n");

  it("ventas: una columna obligatoria más allá de la columna 32 se ignora, igual que en el .xlsx: columnas_faltantes", () => {
    const sinTotal = CABECERA_VENTAS.filter((c) => c !== "total");
    const cabecera = [...sinTotal, ...relleno(LIMITES_VENTAS.maxColumnas - sinTotal.length), "total"]; // «total» queda en la 33.ª
    expect(cabecera.indexOf("total")).toBe(LIMITES_VENTAS.maxColumnas);
    expect(codigo(() => leerCsvTabla(enCsv(cabecera), PERFIL_VENTAS))).toBe("columnas_faltantes");
    expect(codigo(() => leerXlsxTabla(xlsxConCabecera(cabecera), PERFIL_VENTAS))).toBe("columnas_faltantes");
  });

  it("clientes (007b): «Responsable» en la columna 33 del .csv también se ignora: columnas_faltantes", () => {
    const sinResp = CABECERA.filter((c) => c !== "Responsable");
    const cabecera = [...sinResp, ...relleno(LIMITES.maxColumnas - sinResp.length), "Responsable"];
    expect(cabecera.indexOf("Responsable")).toBe(LIMITES.maxColumnas);
    expect(codigo(() => leerCsv(enCsv(cabecera)))).toBe("columnas_faltantes");
  });

  it("caso feliz: columnas de más DESPUÉS de las obligatorias se ignoran sin error y las celdas de datos se leen", () => {
    const cabecera = [...CABECERA_VENTAS, ...relleno(LIMITES_VENTAS.maxColumnas + 10 - CABECERA_VENTAS.length)];
    const datos = ["03", "B001", "290", "", "-", "2026-10-03", "PEN", "", "100.00", "18.00", "0", "0", "0", "0", "0", "118.00"];
    const filas = leerCsvTabla(enCsv(cabecera, [...datos, ...relleno(cabecera.length - datos.length, "v")]), PERFIL_VENTAS);
    expect(filas).toHaveLength(1);
    expect(filas[0]!.valores).toMatchObject({ tipo: "03", serie: "B001", numero: "290", total: "118.00" });
    expect(filas[0]!.n).toBe(2);
  });

  it("caso feliz: justo 32 columnas (la última obligatoria en la 32.ª) se lee", () => {
    const sinTotal = CABECERA_VENTAS.filter((c) => c !== "total");
    const cabecera = [...sinTotal, ...relleno(LIMITES_VENTAS.maxColumnas - sinTotal.length - 1), "total"];
    expect(cabecera).toHaveLength(LIMITES_VENTAS.maxColumnas);
    expect(codigo(() => leerCsvTabla(enCsv(cabecera), PERFIL_VENTAS))).toBeNull();
  });

  describe("las columnas de más no cuestan trabajo", () => {
    afterEach(() => vi.restoreAllMocks());

    it("una cabecera de 100.000 columnas no normaliza más celdas que maxColumnas (la cabecera de ventas, 32)", () => {
      const cabecera = [...CABECERA_VENTAS, ...relleno(100_000)];
      const normalizar = vi.spyOn(String.prototype, "normalize");
      const c = codigo(() => leerCsvTabla(enCsv(cabecera), PERFIL_VENTAS));
      const llamadas = normalizar.mock.calls.length;
      expect(c, "las 16 columnas obligatorias están dentro de las 32: se lee").toBeNull();
      expect(llamadas, "celdas de la cabecera normalizadas").toBeLessThanOrEqual(LIMITES_VENTAS.maxColumnas);
    });

    it("lo mismo en clientes: 100.000 columnas de más en el .csv de 007b", () => {
      const cabecera = [...CABECERA, ...relleno(100_000)];
      const normalizar = vi.spyOn(String.prototype, "normalize");
      const c = codigo(() => leerCsv(enCsv(cabecera)));
      expect(c).toBeNull();
      expect(normalizar.mock.calls.length).toBeLessThanOrEqual(LIMITES.maxColumnas);
    });
  });
});
