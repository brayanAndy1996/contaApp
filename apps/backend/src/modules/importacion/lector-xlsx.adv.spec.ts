// Spec 007b T16 · ronda adversarial (caja blanca) del lector `.xlsx` (T11): consumo desmedido (CA-2).
// `registrosHoja` rellena `celdas` con "" hasta el índice de la columna de cada `<c>`, y `construirFilas` solo cuenta
// las filas NO vacías contra el tope de 1.000. La referencia de la celda no se contrasta con el número de su fila, así
// que `<row><c r="XFD1"/></row>` repetido comprime ~1.000:1: cada fila vacía cuesta 16.384 inserciones y no cuenta.
// Con 20 MB descomprimidos caben ~870.000 filas (~14.000 millones de inserciones con el hilo de eventos tomado).
import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  CABECERA,
  comprimir,
  partesXlsx,
} from "../../../test/soporte-importacion.js";
import { leerXlsx } from "./lector-xlsx.js";

describe("T16 · lector-xlsx sin consumo desmedido", () => {
  it(
    "adv-x1: 10.000 filas vacías con una celda en la columna XFD (zip de ~3 KB) se leen o rechazan en < 1 s",
    { timeout: 60_000 },
    () => {
      const partes = partesXlsx([[...CABECERA]]);
      const hoja = strFromU8(partes["xl/worksheets/sheet1.xml"]!);
      partes["xl/worksheets/sheet1.xml"] = strToU8(
        hoja.replace(
          "</sheetData>",
          `${'<row><c r="XFD1"/></row>'.repeat(10_000)}</sheetData>`,
        ),
      );
      const archivo = comprimir(partes);
      expect(archivo.length).toBeLessThan(16 * 1024);
      const t0 = performance.now();
      try {
        leerXlsx(archivo);
      } catch {
        // Rechazarlo también vale: lo que se mide es el costo.
      }
      expect(
        Math.round(performance.now() - t0),
        "ms para un zip de pocos KB",
      ).toBeLessThan(1_000);
    },
  );
});
