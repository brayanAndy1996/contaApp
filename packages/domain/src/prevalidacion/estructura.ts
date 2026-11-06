// Estructura de cada fila contra el formato (D13, CA-5; plan, Ratificación 2, 3, 10 y 11): los
// textos que viajan al TXT con validarCampo (sin recortar, normalizar ni transliterar), el RUC del
// proveedor con validarRuc cuando el documento es tipo 6, y la fecha de emisión.
import { validarCampo } from "../formatos/campos";
import type { CampoTxt, CodigoCampo, FormatoTxt } from "../formatos/tipos";
import type { Entero } from "../texto/entero";
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

/** Campos del formato cuyo valor es texto de la fila, tal como llegó. */
const TEXTOS: Readonly<Record<string, (f: FilaCopia) => string>> = Object.freeze({
  tipoComprobante: (f) => f.comprobante.tipo,
  serie: (f) => f.comprobante.serie,
  numero: (f) => f.comprobante.numero,
  tipoDocProveedor: (f) => f.proveedor.tipo,
  numeroDocProveedor: (f) => f.proveedor.numero,
  razonSocial: (f) => f.proveedor.razonSocial ?? "",
});

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

/** Errores de los campos de texto de la fila, en el orden del formato. */
function textosDe(f: FilaCopia, formato: FormatoTxt): ErrorPrevalidacion[] {
  const errores: ErrorPrevalidacion[] = [];
  for (const campo of formato.campos) {
    const extraer = Object.hasOwn(TEXTOS, campo.nombre) ? TEXTOS[campo.nombre] : undefined;
    if (extraer === undefined) continue;
    const valor = extraer(f);
    const esRuc = campo.nombre === "numeroDocProveedor" && f.proveedor.tipo === TIPO_DOC_RUC;
    const definicion: CampoTxt = esRuc ? { ...campo, tipo: "ruc" } : campo;
    const e = validarCampo(valor, definicion, formato);
    if (e === null) continue;
    errores.push(
      crearError({
        filaId: f.id,
        codigo: e.codigo,
        campo: campo.nombre,
        explicacion: explicarCampo(e.codigo, campo, valor, e.posicion),
      }),
    );
  }
  return errores;
}

// ---------------------------------------------------------------- fecha de emisión
const FECHA = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
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
export function validarEstructura(f: FilaCopia, formato: FormatoTxt, periodo: string): ErrorPrevalidacion[] {
  return [...textosDe(f, formato), ...fechaDe(f, periodo)];
}
