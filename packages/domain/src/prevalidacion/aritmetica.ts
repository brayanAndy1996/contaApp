// Aritmética de cada fila no excluida (D1, D11; CA-3, CA-4; plan, «Orden de prevalidar» y
// Ratificación 1, 8 y 10). Una sola verdad: verificarCuadre, igvCuadra, TipoCambio.desde y
// convertirAPen de 010, sin reimplementarlos.
import { COLUMNAS_COMPRA, convertirAPen } from "../comprobante/index";
import type { ColumnaCompra, MontosComprobante } from "../comprobante/index";
import {
  MontoFueraDeRangoError,
  TASA_IGV_10,
  TASA_IGV_18,
  TOLERANCIA_CUADRE,
  TipoCambio,
  igvCuadra,
  verificarCuadre,
} from "../dinero/index";
import type { Cuadrable, Moneda, Money, ResultadoCuadre } from "../dinero/index";
import { PARES_DESTINO } from "../reglas/entrada";
import type { OrigenUsd } from "../reglas/index";
import type { FilaCopia } from "./entrada";
import { crearError } from "./errores";
import {
  CUADRE_FUERA_DE_RANGO,
  ORIGEN_DESCUADRADO,
  ORIGEN_FUERA_DE_RANGO,
  TC_EN_PEN,
  TC_INVALIDO,
  TC_ORIGEN_INVALIDO,
  USD_SIN_TC,
  conversionUsd,
  cuadre,
  igvNoCuadra,
} from "./explicaciones";
import type { ErrorPrevalidacion } from "./tipos";

export interface Aritmetica {
  readonly errores: readonly ErrorPrevalidacion[];
  /** origenUsd con su TC ya validado, para evaluarReglas; `null` si no hay o su TC es inválido. */
  readonly origen: OrigenUsd | null;
}

/** TipoCambio de 010 o `null` si `desde` lo rechaza (incluido ""). */
export function tipoCambioDe(tc: string): TipoCambio | null {
  try {
    return TipoCambio.desde(tc);
  } catch {
    // TipoCambio.desde solo lanza FactorInvalidoError con un string.
    return null;
  }
}

/**
 * `calcular()` o `null` si el resultado excede NUMERIC(14,2). Con un MontosComprobante real y un
 * TipoCambio real, MontoFueraDeRangoError es el único error posible de verificarCuadre y de
 * convertirAPen (con montos que cuadran); cualquier otro se propaga.
 */
function enRango<T>(calcular: () => T): T | null {
  try {
    return calcular();
  } catch (e) {
    if (e instanceof MontoFueraDeRangoError) return null;
    throw e;
  }
}

/** verificarCuadre con TOLERANCIA_CUADRE; `null` (no cuadra) si Σ o total − Σ salen de rango. */
function cuadreDe(m: Cuadrable): ResultadoCuadre | null {
  return enRango(() => verificarCuadre(m, TOLERANCIA_CUADRE));
}

/**
 * Solo `null` es «sin TC» (Ratificación 8); una fila PEN con TC tampoco se descarta en silencio. La
 * usan compras y ventas (012b).
 */
export function erroresTipoCambio(filaId: string, moneda: Moneda, tipoCambio: string | null): ErrorPrevalidacion[] {
  const error = (codigo: "USD_SIN_TC" | "TC_INVALIDO", explicacion: string) => [
    crearError({ filaId, codigo, campo: "tipoCambio", explicacion }),
  ];
  if (moneda === "PEN") return tipoCambio === null ? [] : error("TC_INVALIDO", TC_EN_PEN);
  if (tipoCambio === null) return error("USD_SIN_TC", USD_SIN_TC);
  return tipoCambioDe(tipoCambio) === null ? error("TC_INVALIDO", TC_INVALIDO) : [];
}

/** CUADRE con `diferencia = total − Σ` en la moneda de la fila (tolerancia 0.00). Compras y ventas (012b). */
export function erroresCuadre(filaId: string, montos: Cuadrable): ErrorPrevalidacion[] {
  const c = cuadreDe(montos);
  if (c === null) {
    return [crearError({ filaId, codigo: "CUADRE", campo: "total", explicacion: CUADRE_FUERA_DE_RANGO })];
  }
  if (c.cuadra) return [];
  return [
    crearError({
      filaId,
      codigo: "CUADRE",
      campo: "total",
      explicacion: cuadre(c.sumaComponentes, c.total),
      diferencia: c.diferencia,
    }),
  ];
}

/**
 * IGV de un destino aceptable: exactamente 0.00 (D18), o con base distinta de cero, del mismo signo
 * que la base y a 18 % o 10 % según igvCuadra (±0.01). La tolerancia de igvCuadra no salva un IGV
 * sin base ni uno de signo contrario (Ratificación 1, H-012-1).
 */
export function igvAceptable(bi: Money, igv: Money): boolean {
  if (igv.esCero()) return true;
  if (bi.esCero() || bi.esNegativo() !== igv.esNegativo()) return false;
  return igvCuadra(bi, igv, TASA_IGV_18) || igvCuadra(bi, igv, TASA_IGV_10);
}

/** IGV por destino (igvAceptable); un error IGV por destino que no lo es. */
function igvFila(f: FilaCopia): ErrorPrevalidacion[] {
  const errores: ErrorPrevalidacion[] = [];
  for (const par of PARES_DESTINO) {
    const bi = f.montos.obtener(par.bi);
    const igv = f.montos.obtener(par.igv);
    if (igvAceptable(bi, igv)) continue;
    errores.push(
      crearError({
        filaId: f.id,
        codigo: "IGV",
        campo: par.igv,
        destino: par.destino,
        explicacion: igvNoCuadra(igv, bi),
      }),
    );
  }
  return errores;
}

/** Primera columna (o el total) en que la fila PEN difiere de la conversión; `null` si coinciden. */
function primeraDiferencia(m: MontosComprobante, esperado: MontosComprobante): string | null {
  for (const c of COLUMNAS_COMPRA) if (!m.obtener(c).igual(esperado.obtener(c))) return c;
  return m.total.igual(esperado.total) ? null : "total";
}

/**
 * origenUsd contra convertirAPen (D7 de 010). TC inválido → TC_INVALIDO en origenUsd; montos USD
 * descuadrados → CONVERSION_USD sin llamar a convertirAPen; una sola CONVERSION_USD por fila, que
 * nombra la primera columna que difiere.
 */
function origenFila(f: FilaCopia): Aritmetica {
  const origen = f.origenUsd;
  if (origen === null) return { errores: [], origen: null };
  const tc = tipoCambioDe(origen.tipoCambio);
  const conversion = (explicacion: string) =>
    crearError({ filaId: f.id, codigo: "CONVERSION_USD", campo: "origenUsd", explicacion });
  if (tc === null) {
    return {
      errores: [crearError({ filaId: f.id, codigo: "TC_INVALIDO", campo: "origenUsd", explicacion: TC_ORIGEN_INVALIDO })],
      origen: null,
    };
  }
  const evaluable: OrigenUsd = Object.freeze({ montos: origen.montos, tipoCambio: tc });
  if (cuadreDe(origen.montos)?.cuadra !== true) {
    return { errores: [conversion(ORIGEN_DESCUADRADO)], origen: evaluable };
  }
  const esperado = enRango(() => convertirAPen(origen.montos, tc));
  if (esperado === null) return { errores: [conversion(ORIGEN_FUERA_DE_RANGO)], origen: evaluable };
  const campo = primeraDiferencia(f.montos, esperado);
  if (campo === null) return { errores: [], origen: evaluable };
  const valor = campo === "total" ? esperado.total : esperado.obtener(campo as ColumnaCompra);
  return { errores: [conversion(conversionUsd(campo, valor))], origen: evaluable };
}

/** TC, cuadre, IGV y origenUsd de una fila no excluida. */
export function validarAritmetica(f: FilaCopia): Aritmetica {
  const origen = origenFila(f);
  return {
    errores: [
      ...erroresTipoCambio(f.id, f.montos.moneda, f.tipoCambio),
      ...erroresCuadre(f.id, f.montos),
      ...igvFila(f),
      ...origen.errores,
    ],
    origen: origen.origen,
  };
}
