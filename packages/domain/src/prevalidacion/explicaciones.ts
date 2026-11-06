// Catálogo fijo de explicaciones de la prevalidación (plan 012, Decisiones «Explicaciones» y
// Ratificación 15). Llevan cifras canónicas de Money, nombres de campo, límites del formato,
// posiciones, `U+XXXX` y, en DUPLICADO, los ids de las otras copias. Nunca texto de la fila tal como
// llegó (razón social, serie, número, documento, fecha o TC). IGV y cuadre reutilizan el texto de 011.
import type { Money } from "../dinero/index";
import type { Entero } from "../texto/entero";
import { mix, red } from "../reglas/explicaciones";

/** Mismo texto que R-MIX: «{igv} no es 18 % ni 10 % de {bi}». */
export const igvNoCuadra = (igv: Money, bi: Money): string => mix(igv, bi);

/** Mismo texto que R-RED: «La suma de componentes ({suma}) no es igual al total ({total}): diferencia {dif}». */
export const cuadre = (suma: Money, total: Money): string => red(suma, total);

/** Σ o total − Σ exceden NUMERIC(14,2): no hay cifra canónica que mostrar. */
export const CUADRE_FUERA_DE_RANGO = "La suma de componentes no es igual al total y excede el rango de montos";

export const obligatorio = (campo: string): string => `El campo ${campo} es obligatorio`;

export const longitud = (campo: string, maximo: Entero): string =>
  `El campo ${campo} supera el máximo de ${maximo} caracteres`;

export const patron = (campo: string): string => `El campo ${campo} no tiene el formato esperado`;

export const rucInvalido = (campo: string): string => `El campo ${campo} no es un RUC válido`;

/** `U+XXXX` del punto de código completo (un emoji da U+1F600, no su sustituto). */
export const caracterNoPermitido = (campo: string, posicion: Entero, punto: string): string =>
  `El campo ${campo} tiene un carácter no permitido (${punto}) en la posición ${posicion}`;

export const FECHA_INVALIDA = "El campo fechaEmision no es una fecha válida con la forma AAAA-MM-DD";

export const fechaPosterior = (periodo: string): string =>
  `El campo fechaEmision es posterior al último día del periodo ${periodo}`;

export const USD_SIN_TC = "El campo tipoCambio es obligatorio en un comprobante en USD";

export const TC_INVALIDO =
  "El campo tipoCambio no es un tipo de cambio válido: mayor que cero, hasta 4 enteros y 3 decimales";

export const TC_EN_PEN = "El campo tipoCambio debe quedar vacío en un comprobante en PEN";

export const TC_ORIGEN_INVALIDO =
  "El tipo de cambio de origenUsd no es válido: mayor que cero, hasta 4 enteros y 3 decimales";

export const ORIGEN_DESCUADRADO = "Los montos en USD de origenUsd no cuadran: no se pueden convertir";

export const ORIGEN_FUERA_DE_RANGO = "La conversión de origenUsd a PEN excede el rango de montos";

export const conversionUsd = (campo: string, esperado: Money): string =>
  `El campo ${campo} no coincide con la conversión por componente de origenUsd (${esperado.toString()})`;

/** Máximo de ids que nombra la explicación de DUPLICADO: queda acotada aunque haya miles de copias (H-012-2). */
export const MAX_IDS_DUPLICADO = 20;

/** Nombra hasta MAX_IDS_DUPLICADO de las otras copias y cuenta las demás («y N más»). */
export const duplicado = (otros: readonly string[], resto: Entero): string =>
  `El comprobante se repite en las filas ${otros.join(", ")}${resto > 0 ? ` y ${resto} más` : ""}`;

export const SIN_FILAS = "No hay filas para generar: la lista está vacía o todas las filas están excluidas";
