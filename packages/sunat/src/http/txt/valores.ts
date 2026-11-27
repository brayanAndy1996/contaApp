/**
 * Valores de las celdas del TXT del SIRE (plan 041, Decisiones «Montos»; spec CA-6, CA-7). Nunca se redondea ni se
 * adivina: lo que no cumple la gramática es `ErrorDatosSire("fila_invalida")`. Montos con `Money`, jamás `number`.
 * Errores con mensaje fijo: no copian el valor de la celda.
 */
import { Money } from "@contapp/domain";
import { ErrorDatosSire } from "../../errores.js";
import { indicesPorEncabezado, normalizarEncabezado } from "./encabezados.js";

export interface EsperadoTxt {
  ruc: string;
  periodo: string;
}

export type MonedaSire = "PEN" | "USD";

const GRAMATICA_MONTO = /^-?\d{1,12}(\.\d{1,2})?$/;
const GRAMATICA_CERO = /^-?0+(\.0{1,2})?$/;
const GRAMATICA_TIPO_CAMBIO = /^\d{1,4}\.\d{1,3}$/;
const GRAMATICA_FECHA = /^(\d{2})\/(\d{2})\/(\d{4})$/;

export function filaInvalida(): ErrorDatosSire {
  return new ErrorDatosSire("fila_invalida");
}

/**
 * Valida el encabezado (requeridas presentes y sin repetir) y devuelve el índice de cada columna por nombre. Se
 * resuelve una vez por archivo, no por fila.
 */
export function columnas(encabezado: readonly string[], requeridas: readonly string[]): (nombre: string) => number {
  const indices = indicesPorEncabezado(encabezado, requeridas);
  return (nombre) => {
    const i = indices.get(normalizarEncabezado(nombre));
    if (i === undefined) throw new Error("columna no declarada como requerida");
    return i;
  };
}

/**
 * Recorta solo espacios y tabuladores ASCII (como el encabezado). `String#trim` también quitaría NBSP, U+3000 y demás
 * espacios Unicode, y `"500\u00a0"` pasaría por monto (H-041-1-3): esos caracteres quedan en la celda y la gramática
 * estricta (solo ASCII) de montos, tipo de cambio, fecha, RUC y periodo la rechaza.
 */
export function celda(fila: readonly string[], i: number): string {
  return (fila[i] ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Toda fila debe ser del RUC y periodo pedidos; si una no lo es, no se devuelve ninguna (CA-6). */
export function verificarPropias(filas: readonly (readonly string[])[], iRuc: number, iPeriodo: number, e: EsperadoTxt): void {
  for (const f of filas) {
    if (celda(f, iRuc) !== e.ruc || celda(f, iPeriodo) !== e.periodo) throw new ErrorDatosSire("respuesta_ajena");
  }
}

export function moneda(valor: string): MonedaSire {
  if (valor === "PEN" || valor === "USD") return valor;
  throw filaInvalida();
}

/** Monto `^-?\d{1,12}(\.\d{1,2})?$` → cadena canónica de 2 decimales vía `Money`. */
export function monto(valor: string, m: MonedaSire): string {
  if (!GRAMATICA_MONTO.test(valor)) throw filaInvalida();
  try {
    return Money.desde(valor, m).toString();
  } catch {
    throw filaInvalida();
  }
}

export function tipoCambio(valor: string): string {
  if (!GRAMATICA_TIPO_CAMBIO.test(valor)) throw filaInvalida();
  return valor;
}

/** `dd/mm/aaaa` con calendario real → `aaaa-mm-dd`. */
export function fecha(valor: string): string {
  const m = GRAMATICA_FECHA.exec(valor);
  if (m === null) throw filaInvalida();
  const [, dd = "", mm = "", aaaa = ""] = m;
  const dia = Number.parseInt(dd, 10);
  const mes = Number.parseInt(mm, 10);
  const anio = Number.parseInt(aaaa, 10);
  if (anio < 1 || mes < 1 || mes > 12 || dia < 1 || dia > diasDelMes(anio, mes)) throw filaInvalida();
  return `${aaaa}-${mm}-${dd}`;
}

function diasDelMes(anio: number, mes: number): number {
  if (mes === 2) return anio % 4 === 0 && (anio % 100 !== 0 || anio % 400 === 0) ? 29 : 28;
  return mes === 4 || mes === 6 || mes === 9 || mes === 11 ? 30 : 31;
}

export function obligatorio(valor: string): string {
  if (valor === "") throw filaInvalida();
  return valor;
}

/**
 * Columna monetaria o de rango sin equivalente en el puerto (P-2, CA-7): vacía o cero pasa; otro monto válido es
 * `columna_no_soportada` (no se pierde en silencio); un formato inválido es `fila_invalida`.
 */
export function sinEquivalente(valor: string): void {
  if (valor === "") return;
  if (!GRAMATICA_MONTO.test(valor)) throw filaInvalida();
  if (!GRAMATICA_CERO.test(valor)) throw new ErrorDatosSire("columna_no_soportada");
}
