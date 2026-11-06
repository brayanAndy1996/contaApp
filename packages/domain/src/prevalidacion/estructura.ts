// Estructura de cada fila contra el formato (D13, CA-5; plan, Ratificación 2, 3, 10 y 11): cada
// campo del formato con validarCampo, con el mismo valor que escribe generarTxt (los textos sin
// recortar, normalizar ni transliterar; H-012-23), el RUC del proveedor con validarRuc cuando el
// documento es tipo 6, y la fecha de emisión.
import { validarCampo } from "../formatos/campos";
import type { CabeceraTxt, CampoTxt, CodigoCampo, FormatoTxt } from "../formatos/tipos";
import { valorDeCampo } from "../formatos/valores";
import type { Entero } from "../texto/entero";
import { tipoCambioDe } from "./aritmetica";
import type { FilaCopia } from "./entrada";
import { crearError } from "./errores";
import {
  FECHA_INVALIDA,
  caracterNoPermitido,
  fechaPosterior,
  longitud,
  obligatorio,
  patron,
  rucInvalido,
} from "./explicaciones";
import type { CodigoError, ErrorPrevalidacion } from "./tipos";

/** Códigos que son «error de estructura»: esas filas no pasan a evaluarReglas (Ratificación 10). */
export const CODIGOS_ESTRUCTURA: ReadonlySet<CodigoError> = new Set<CodigoError>([
  "CAMPO_OBLIGATORIO",
  "LONGITUD",
  "PATRON",
  "CARACTER_NO_PERMITIDO",
  "RUC_INVALIDO",
]);

/** Documento de identidad del proveedor que es RUC (se valida con su dígito verificador). */
const TIPO_DOC_RUC = "6";

/** `U+XXXX` del punto de código que empieza en `posicion`. */
export function puntoDeCodigo(valor: string, posicion: Entero): string {
  return `U+${(valor.codePointAt(posicion) as Entero).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Explicación de un error de validarCampo (o de validarRuc en la cabecera). */
export function explicarCampo(codigo: CodigoCampo, campo: CampoTxt, valor: string, posicion: Entero | null): string {
  switch (codigo) {
    case "CAMPO_OBLIGATORIO":
      return obligatorio(campo.nombre);
    case "LONGITUD":
      return longitud(campo.nombre, campo.longitudMax);
    case "PATRON":
      return patron(campo.nombre);
    case "RUC_INVALIDO":
      return rucInvalido(campo.nombre);
    case "CARACTER_NO_PERMITIDO":
      // validarCampo siempre da la posición del carácter ofensor con este código.
      return caracterNoPermitido(campo.nombre, posicion as Entero, puntoDeCodigo(valor, posicion as Entero));
  }
}

const tcValido = (tc: string | null): boolean => tc !== null && tipoCambioDe(tc) !== null;

/**
 * Valor que generarTxt escribiría en el campo, o `null` si no se valida aquí: el periodo (de la
 * cabecera, se valida una vez en validarCabecera), una fecha o un TC de USD que ya tienen su propio
 * error (FECHA_INVALIDA, USD_SIN_TC o TC_INVALIDO). Todo campo registrado tiene valor (D21).
 */
function valorDe(f: FilaCopia, nombre: string, cabecera: CabeceraTxt): string | null {
  if (nombre === "periodo") return null;
  if (nombre === "fechaEmision" && !esFechaValida(f.fechaEmision)) return null;
  if (nombre === "tipoCambio" && f.montos.moneda === "USD" && !tcValido(f.tipoCambio)) return null;
  return valorDeCampo(nombre)(f, cabecera);
}

/** Error de validarCampo de un campo del formato con su valor, o `null`. */
function errorDeCampo(filaId: string | null, campo: CampoTxt, valor: string, formato: FormatoTxt): ErrorPrevalidacion | null {
  const e = validarCampo(valor, campo, formato);
  if (e === null) return null;
  return crearError({ filaId, codigo: e.codigo, campo: campo.nombre, explicacion: explicarCampo(e.codigo, campo, valor, e.posicion) });
}

/**
 * Definición con la que se valida el campo en esta fila: el documento del proveedor tipo 6 se valida
 * como RUC, y la obligatoriedad de `tipoCambio` rige solo en USD (D23): en PEN el TC se escribe
 * «» (Ratificación 4) y un TC no nulo ya es TC_INVALIDO (Ratificación 8).
 */
function definicionPara(f: FilaCopia, campo: CampoTxt): CampoTxt {
  if (campo.nombre === "numeroDocProveedor" && f.proveedor.tipo === TIPO_DOC_RUC) return { ...campo, tipo: "ruc" };
  if (campo.nombre === "tipoCambio" && campo.obligatorio && f.montos.moneda !== "USD") return { ...campo, obligatorio: false };
  return campo;
}

/**
 * Errores de todos los campos de la fila contra el formato, en su orden: los textos tal como
 * llegaron y, además, fecha, moneda, TC, montos y total tal como se serializan (H-012-23).
 */
function camposDe(f: FilaCopia, formato: FormatoTxt, cabecera: CabeceraTxt): ErrorPrevalidacion[] {
  const errores: ErrorPrevalidacion[] = [];
  for (const campo of formato.campos) {
    const valor = valorDe(f, campo.nombre, cabecera);
    if (valor === null) continue;
    const definicion = definicionPara(f, campo);
    const e = errorDeCampo(f.id, definicion, valor, formato);
    if (e !== null) errores.push(e);
  }
  return errores;
}

/** Campos de la cabecera que van a cada línea (hoy el periodo), una sola vez y con `filaId: null`. */
export function validarCabecera(cabecera: CabeceraTxt, formato: FormatoTxt): ErrorPrevalidacion[] {
  const errores: ErrorPrevalidacion[] = [];
  for (const campo of formato.campos) {
    if (campo.nombre !== "periodo") continue;
    const e = errorDeCampo(null, campo, cabecera.periodo, formato);
    if (e !== null) errores.push(e);
  }
  return errores;
}

// ---------------------------------------------------------------- fecha de emisión
/** El año 0000 no existe en el calendario gregoriano (H-012-3). */
const FECHA = /^(?!0000)([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
/** Número de dos cifras múltiplo de 4 (00, 04, …, 96). */
const MULTIPLO_DE_4 = /^([02468][048]|[13579][26])$/;
const ULTIMO_DIA: Readonly<Record<string, string>> = Object.freeze({
  "01": "31",
  "02": "28",
  "03": "31",
  "04": "30",
  "05": "31",
  "06": "30",
  "07": "31",
  "08": "31",
  "09": "30",
  "10": "31",
  "11": "30",
  "12": "31",
});

/** Gregoriano: múltiplo de 4, salvo los siglos que no son múltiplo de 400. Solo texto, sin `number`. */
function esBisiesto(anio: string): boolean {
  const decenas = anio.slice(2);
  return decenas === "00" ? MULTIPLO_DE_4.test(anio.slice(0, 2)) : MULTIPLO_DE_4.test(decenas);
}

/** `true` si `fecha` es AAAA-MM-DD (dígitos ASCII) y el día existe en ese mes. */
export function esFechaValida(fecha: string): boolean {
  const m = FECHA.exec(fecha);
  if (m === null) return false;
  const [, anio, mes, dia] = m as unknown as [string, string, string, string];
  const ultimo = mes === "02" && esBisiesto(anio) ? "29" : (ULTIMO_DIA[mes] as string);
  return dia <= ultimo;
}

function fechaDe(f: FilaCopia, periodo: string): ErrorPrevalidacion[] {
  if (!esFechaValida(f.fechaEmision)) {
    return [crearError({ filaId: f.id, codigo: "FECHA_INVALIDA", campo: "fechaEmision", explicacion: FECHA_INVALIDA })];
  }
  // El día ya existe en su mes: basta comparar AAAAMM. Una fecha anterior al periodo es válida.
  const mes = f.fechaEmision.slice(0, 4) + f.fechaEmision.slice(5, 7);
  if (mes <= periodo) return [];
  return [
    crearError({
      filaId: f.id,
      codigo: "FECHA_POSTERIOR_AL_PERIODO",
      campo: "fechaEmision",
      explicacion: fechaPosterior(periodo),
    }),
  ];
}

/** Errores de estructura y de fecha de una fila no excluida. */
export function validarEstructura(f: FilaCopia, formato: FormatoTxt, cabecera: CabeceraTxt): ErrorPrevalidacion[] {
  return [...camposDe(f, formato, cabecera), ...fechaDe(f, cabecera.periodo)];
}
