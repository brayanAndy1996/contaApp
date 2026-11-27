/**
 * TXT del SIRE → celdas (plan 041, Decisiones «Encabezado»; spec CA-4, CA-6, CA-10, P-6). Síncrona y pura.
 * UTF-8 estricto (sin adivinar la codificación), BOM fuera, `\n` o `\r\n`, separador `|`. Cada fila sale con
 * exactamente tantas celdas como el encabezado: se acepta UNA celda vacía de más (el `|` final). Errores con
 * mensaje fijo: no llevan texto del archivo.
 */
import { ErrorDatosSire, ErrorPortalSire } from "../../errores.js";

export interface TxtLeido {
  encabezado: string[];
  filas: string[][];
}

const decodificador = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function leerTxt(bytes: Uint8Array): TxtLeido {
  let texto: string;
  try {
    texto = decodificador.decode(bytes);
  } catch {
    throw new ErrorPortalSire("codificacion");
  }
  let encabezado: string[] | undefined;
  const filas: string[][] = [];
  // Si el archivo usa el `|` final, una fila que termina en `|` con justo `encabezado.length` celdas perdió una celda
  // (no puede ser «sin `|` final con la última columna vacía»): se decide al terminar, sin una segunda pasada.
  let usaBarraFinal = false;
  let filaDudosa = false;
  let desde = 0;
  while (desde <= texto.length) {
    let hasta = texto.indexOf("\n", desde);
    if (hasta < 0) hasta = texto.length;
    const fin = hasta > desde && texto.charCodeAt(hasta - 1) === 13 ? hasta - 1 : hasta;
    const linea = texto.slice(desde, fin);
    desde = hasta + 1;
    if (linea === "") continue;
    const celdas = linea.split("|");
    if (encabezado === undefined) {
      // El `|` final del encabezado es opcional: una última columna sin nombre no existe.
      if (celdas.length > 1 && celdas[celdas.length - 1] === "") celdas.pop();
      encabezado = celdas;
      continue;
    }
    const terminaEnBarra = celdas[celdas.length - 1] === "";
    if (celdas.length === encabezado.length + 1 && terminaEnBarra) {
      celdas.pop();
      usaBarraFinal = true;
    } else if (celdas.length === encabezado.length) {
      if (terminaEnBarra) filaDudosa = true;
    } else {
      throw new ErrorDatosSire("fila_invalida");
    }
    filas.push(celdas);
  }
  if (encabezado === undefined) throw new ErrorPortalSire("encabezado");
  if (usaBarraFinal && filaDudosa) throw new ErrorDatosSire("fila_invalida");
  return { encabezado, filas };
}
