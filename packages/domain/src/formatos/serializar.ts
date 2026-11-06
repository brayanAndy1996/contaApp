// generarTxt (D4-D8, D14, D17; plan, «generarTxt» y Ratificación 4, 6, 9 y 12). Orden: entrada y
// cabecera (una sola lectura a copias congeladas), seleccionarFormato, FormatoProvisionalError,
// prevalidar esas mismas copias (ArchivoNoPrevalidadoError) y, al final, serializar y codificar.
// No acepta un formato suelto: la versión la elige el registro (D5).
import { compararTexto, leerCabecera, leerFilas, leerObjeto, invalida } from "../prevalidacion/entrada";
import type { FilaCopia } from "../prevalidacion/entrada";
import { prevalidarCopia } from "../prevalidacion/prevalidar";
import type { FilaReemplazo } from "../prevalidacion/tipos";
import { codificar } from "../texto/codificar";
import type { Entero } from "../texto/entero";
import {
  ArchivoNoPrevalidadoError,
  DefinicionFormatoInvalidaError,
  FormatoProvisionalError,
  NombreArchivoInvalidoError,
} from "./errores";
import { seleccionarFormato } from "./registro";
import type { RegistroFormatos } from "./registro";
import type { CabeceraTxt, NombresArchivo } from "./tipos";
import { VALORES } from "./valores";

export interface OpcionesGenerarTxt {
  readonly permitirProvisional?: boolean;
  readonly registro?: RegistroFormatos;
}

export interface ResultadoGenerarTxt {
  readonly bytes: Uint8Array;
  readonly nombreTxt: string;
  readonly nombreZip: string;
  readonly provisional: boolean;
  readonly lineas: Entero;
  readonly formato: { readonly id: string; readonly version: string };
}

const CLAVES_OPCIONES = ["permitirProvisional", "registro"];
/** Nombre seguro (Ratificación 6): sin `/`, `\`, espacios ni controles; `..` se rechaza aparte. */
const NOMBRE_SEGURO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CEROS_IZQUIERDA = /^0+/;

// ---------------------------------------------------------------- orden (D6)
/** Número sin ceros a la izquierda: primero por largo y luego por texto, sin `number`. */
function compararNumero(a: string, b: string): -1 | 0 | 1 {
  const x = a.replace(CEROS_IZQUIERDA, "");
  const y = b.replace(CEROS_IZQUIERDA, "");
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return compararTexto(x, y);
}

/** Fecha, tipo, serie (texto), número, tipo y número del documento, e id. */
function compararFilas(a: FilaCopia, b: FilaCopia): -1 | 0 | 1 {
  return (
    compararTexto(a.fechaEmision, b.fechaEmision) ||
    compararTexto(a.comprobante.tipo, b.comprobante.tipo) ||
    compararTexto(a.comprobante.serie, b.comprobante.serie) ||
    compararNumero(a.comprobante.numero, b.comprobante.numero) ||
    compararTexto(a.proveedor.tipo, b.proveedor.tipo) ||
    compararTexto(a.proveedor.numero, b.proveedor.numero) ||
    compararTexto(a.id, b.id)
  );
}

// ---------------------------------------------------------------- nombres (D7)
/** Lo que devuelve `formato.nombre`, leído una vez: nombres seguros y `nombreZip` = base + `.zip`. */
function nombresSeguros(n: unknown): NombresArchivo {
  if (typeof n !== "object" || n === null) throw new NombreArchivoInvalidoError();
  const { nombreTxt, nombreZip } = n as Record<string, unknown>;
  const seguro = (x: unknown): x is string => typeof x === "string" && NOMBRE_SEGURO.test(x) && !x.includes("..");
  if (!seguro(nombreTxt) || !seguro(nombreZip)) throw new NombreArchivoInvalidoError();
  const punto = nombreTxt.lastIndexOf(".");
  const base = punto < 0 ? nombreTxt : nombreTxt.slice(0, punto);
  if (nombreZip !== `${base}.zip` || nombreZip === nombreTxt) throw new NombreArchivoInvalidoError();
  return Object.freeze({ nombreTxt, nombreZip });
}

function leerOpciones(o: unknown): { permitirProvisional: boolean; registro: RegistroFormatos | undefined } {
  if (o === undefined) return { permitirProvisional: false, registro: undefined };
  const v = leerObjeto(o, CLAVES_OPCIONES, []);
  const permitir = v.get("permitirProvisional");
  if (permitir !== undefined && typeof permitir !== "boolean") invalida();
  return { permitirProvisional: permitir === true, registro: v.get("registro") as RegistroFormatos | undefined };
}

/**
 * Genera el TXT del periodo. Lanza FormatoNoVigenteError, FormatoProvisionalError (formato
 * `oficial: false` sin `permitirProvisional`) o ArchivoNoPrevalidadoError (sin bytes) antes de
 * serializar. Las líneas siguen un orden estable (D6) y omiten las excluidas si el formato no las
 * incluye (D14). `codificar` es la segunda barrera: lanza si un carácter no cabe.
 */
export function generarTxt(
  filas: readonly FilaReemplazo[],
  cabecera: CabeceraTxt,
  opciones?: OpcionesGenerarTxt,
): ResultadoGenerarTxt {
  const op = leerOpciones(opciones);
  const copias = leerFilas(filas);
  const cab = leerCabecera(cabecera);
  const formato = seleccionarFormato(cab.libro, cab.periodo, op.registro);
  if (!formato.oficial && !op.permitirProvisional) throw new FormatoProvisionalError();
  const { resultado, generables } = prevalidarCopia(copias, cab, formato, null);
  if (!resultado.apto) throw new ArchivoNoPrevalidadoError(resultado);
  const valores = formato.campos.map((campo) => {
    const valor = VALORES.get(campo.nombre);
    if (valor === undefined) throw new DefinicionFormatoInvalidaError();
    return valor;
  });
  const nombres = nombresSeguros(formato.nombre({ ruc: cab.rucDeclarante, periodo: cab.periodo }));
  const ordenadas = [...generables].sort(compararFilas);
  const texto = ordenadas
    .map((f) => valores.map((valor) => valor(f, cab)).join(formato.separador) + formato.finDeLinea)
    .join("");
  return Object.freeze({
    bytes: codificar(texto, formato.codificacion),
    nombreTxt: nombres.nombreTxt,
    nombreZip: nombres.nombreZip,
    provisional: !formato.oficial,
    lineas: ordenadas.length,
    formato: Object.freeze({ id: formato.id, version: formato.version }),
  });
}
