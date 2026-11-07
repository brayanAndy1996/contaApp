// Lector de `.csv` de importación (spec 007b, D7): UTF-8 con o sin BOM, separador `,` o `;`, comillas RFC 4180.
// Pura: todo en memoria, sin disco ni logs; los errores llevan solo el código.
import {
  construirFilas,
  construirTabla,
  type FilaTabla,
  type PerfilTabla,
  type Registro,
} from "./tabla.js";
import { ErrorArchivo, LIMITES, type ArchivoLeido } from "./tipos.js";

/** El separador es el que más aparece (fuera de comillas) en la primera línea con contenido. */
function detectarSeparador(texto: string): "," | ";" {
  let comas = 0;
  let puntoComas = 0;
  let comillas = false;
  let contenido = false;
  for (const c of texto) {
    if (c === '"') comillas = !comillas;
    else if (!comillas && (c === "\n" || c === "\r")) {
      if (contenido) break;
    } else if (!comillas && c === ",") comas++;
    else if (!comillas && c === ";") puntoComas++;
    if (c.trim() !== "") contenido = true;
  }
  return puntoComas > comas ? ";" : ",";
}

const FIN_O_COMILLA = /["\r\n]/g;

/** Registros del texto; `n` es el número de registro (una línea vacía cuenta). */
function* registros(texto: string, sep: string, maxColumnas: number): Generator<Registro> {
  let celdas: string[] = [];
  let campo = "";
  let comillas = false;
  let n = 1;
  let i = 0;
  // Las columnas más allá de `maxColumnas` se ignoran, como en el `.xlsx` (H-013-2): no se guardan ni se normalizan.
  const cerrar = () => {
    if (celdas.length < maxColumnas) celdas.push(campo);
    campo = "";
  };
  while (i < texto.length) {
    const c = texto[i] as string;
    if (comillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else comillas = false;
      } else campo += c;
    } else if (c === '"') {
      comillas = true;
    } else if (c === sep) {
      cerrar();
      // Superado el tope de columnas el resto de la línea no importa: se salta hasta la próxima comilla o fin de línea.
      if (celdas.length >= maxColumnas) {
        FIN_O_COMILLA.lastIndex = i + 1;
        const m = FIN_O_COMILLA.exec(texto);
        i = m === null ? texto.length : m.index - 1;
      }
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      cerrar();
      yield { n, celdas };
      celdas = [];
      n++;
    } else campo += c;
    i++;
  }
  if (comillas) throw new ErrorArchivo("archivo_invalido");
  if (campo !== "" || celdas.length > 0) {
    cerrar();
    yield { n, celdas };
  }
}

/** Registros del `.csv` UTF-8 (BOM opcional, separador `,` o `;`) con los topes del perfil; lanza `ErrorArchivo`. */
function leerRegistros(
  datos: Uint8Array,
  maxBytes: number,
): { texto: string; sep: "," | ";" } {
  if (datos.length > maxBytes) throw new ErrorArchivo("archivo_demasiado_grande");
  if (datos.length === 0) throw new ErrorArchivo("archivo_invalido");
  let texto: string;
  try {
    texto = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      datos,
    );
  } catch {
    throw new ErrorArchivo("archivo_invalido");
  }
  // Un NUL no aparece en un CSV de texto: es un binario (p. ej. un `.xlsx` subido como `.csv`).
  if (texto.includes("\u0000")) throw new ErrorArchivo("archivo_invalido");
  return { texto, sep: detectarSeparador(texto) };
}

/** Lee un `.csv` con el perfil de otro uso (ventas, 013): sus topes y sus columnas; lanza `ErrorArchivo`. */
export function leerCsvTabla<C extends string>(
  datos: Uint8Array,
  perfil: PerfilTabla<C>,
): FilaTabla<C>[] {
  const { texto, sep } = leerRegistros(datos, perfil.limites.maxBytes);
  return construirTabla(registros(texto, sep, perfil.limites.maxColumnas), perfil);
}

/** Lee un `.csv` de clientes (007b); lanza `ErrorArchivo`. */
export function leerCsv(datos: Uint8Array): ArchivoLeido {
  const { texto, sep } = leerRegistros(datos, LIMITES.maxBytes);
  return construirFilas(registros(texto, sep, LIMITES.maxColumnas));
}
