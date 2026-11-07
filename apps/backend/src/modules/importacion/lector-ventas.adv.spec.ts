// Spec 013 T17 · ronda adversarial del lector de 007b parametrizado para ventas (`LIMITES_VENTAS`: 20.000 filas, 32 columnas,
// 8 MB, 32 MB descomprimidos). Lo que se mide es el costo de un archivo pequeño y hostil: el tope de filas o de columnas
// debe cortar el trabajo antes de que crezca con el archivo (H-007b-1), también con los topes más holgados de ventas.
import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { comprimir, partesXlsx } from "../../../test/soporte-importacion.js";
import { CABECERA_VENTAS } from "../../../test/soporte-ventas.js";
import { leerCsvTabla } from "./lector-csv.js";
import { leerXlsxTabla } from "./lector-xlsx.js";
import { columnasDePerfil, type PerfilTabla } from "./tabla.js";
import { ErrorArchivo, LIMITES_VENTAS } from "./tipos.js";

const PERFIL: PerfilTabla<string> = {
  limites: LIMITES_VENTAS,
  columnas: columnasDePerfil([...CABECERA_VENTAS]),
  obligatorias: [...CABECERA_VENTAS].filter((c) => c !== "tipoDocContraparte" && c !== "tipoCambio"),
};

/** Corre `fn` y devuelve los ms y el código del `ErrorArchivo` (o `null` si leyó). */
function medir(fn: () => unknown): { ms: number; codigo: string | null } {
  const t0 = performance.now();
  let codigo: string | null = null;
  try {
    fn();
  } catch (e) {
    if (!(e instanceof ErrorArchivo)) throw e;
    codigo = e.codigo;
  }
  return { ms: Math.round(performance.now() - t0), codigo };
}

/** `.xlsx` de ventas con la cabecera y `relleno` insertado al final de `sheetData`. */
function xlsxConRelleno(relleno: string): Uint8Array {
  const partes = partesXlsx([[...CABECERA_VENTAS]]);
  const hoja = strFromU8(partes["xl/worksheets/sheet1.xml"]!);
  partes["xl/worksheets/sheet1.xml"] = strToU8(hoja.replace("</sheetData>", `${relleno}</sheetData>`));
  return comprimir(partes);
}

describe("T17 · lector parametrizado de ventas: sin trabajo proporcional al archivo", () => {
  it(
    "adv-l1: `.xlsx` de ~250 KB con ~5 millones de `<row/>` (30 MB de XML, bajo el tope de 32 MB) se rechaza por filas en < 3 s",
    { timeout: 120_000 },
    () => {
      const archivo = xlsxConRelleno("<row/>".repeat(5_000_000));
      expect(archivo.length).toBeLessThan(LIMITES_VENTAS.maxBytes);
      const r = medir(() => leerXlsxTabla(archivo, PERFIL));
      expect(r.codigo, "un archivo con millones de filas no se lee").not.toBeNull();
      expect(r.ms, "ms para cortar en la fila 20.002").toBeLessThan(3_000);
    },
  );

  it(
    "adv-l2: `.csv` de 8 MB con una cabecera de ~8 millones de columnas vacías: se lee o rechaza en < 3 s (las columnas de más no cuestan)",
    { timeout: 120_000, retry: 2 },
    () => {
      const cabecera = CABECERA_VENTAS.join(",");
      const relleno = ",".repeat(LIMITES_VENTAS.maxBytes - cabecera.length - 10);
      const archivo = strToU8(`${cabecera}${relleno}\r\n`);
      expect(archivo.length).toBeLessThanOrEqual(LIMITES_VENTAS.maxBytes);
      const r = medir(() => leerCsvTabla(archivo, PERFIL));
      expect(r.ms, "ms para una sola línea de 8 MB").toBeLessThan(3_000);
    },
  );

  it(
    "adv-l3: H-007b-1 con los topes de ventas: 20.000 filas `<row><c r=\"XFD1\"/></row>` se leen o rechazan en < 3 s",
    { timeout: 60_000, retry: 2 },
    () => {
      const archivo = xlsxConRelleno('<row><c r="XFD1"/></row>'.repeat(20_000));
      const r = medir(() => leerXlsxTabla(archivo, PERFIL));
      // T22a: el reloj es solo una red de seguridad; la comprobación exacta es el conteo de trabajo de correcciones-t18.spec.ts.
      expect(r.ms).toBeLessThan(3_000);
    },
  );
});
