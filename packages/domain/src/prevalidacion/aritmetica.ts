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
import type { ResultadoCuadre } from "../dinero/index";
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
function tipoCambioDe(tc: string): TipoCambio | null {
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
function cuadreDe(m: MontosComprobante): ResultadoCuadre | null {
  return enRango(() => verificarCuadre(m, TOLERANCIA_CUADRE));
}

/** Solo `null` es «sin TC» (Ratificación 8); una fila PEN con TC tampoco se descarta en silencio. */
function tipoCambioFila(f: FilaCopia): ErrorPrevalidacion[] {
  const error = (codigo: "USD_SIN_TC" | "TC_INVALIDO", explicacion: string) => [
    crearError({ filaId: f.id, codigo, campo: "tipoCambio", explicacion }),
  ];
  if (f.montos.moneda === "PEN") return f.tipoCambio === null ? [] : error("TC_INVALIDO", TC_EN_PEN);
  if (f.tipoCambio === null) return error("USD_SIN_TC", USD_SIN_TC);
  return tipoCambioDe(f.tipoCambio) === null ? error("TC_INVALIDO", TC_INVALIDO) : [];
}

/** CUADRE con `diferencia = total − Σ` en la moneda de la fila (tolerancia 0.00). */
function cuadreFila(f: FilaCopia): ErrorPrevalidacion[] {
  const c = cuadreDe(f.montos);
  if (c === null) {
    return [crearError({ filaId: f.id, codigo: "CUADRE", campo: "total", explicacion: CUADRE_FUERA_DE_RANGO })];
  }
  if (c.cuadra) return [];
  return [
    crearError({
      filaId: f.id,
      codigo: "CUADRE",
      campo: "total",
      explicacion: cuadre(c.sumaComponentes, c.total),
      diferencia: c.diferencia,
    }),
  ];
}

/** IGV por destino a 18 % o 10 % (±0.01). Un IGV exactamente 0.00 nunca es error IGV (D18). */
function igvFila(f: FilaCopia): ErrorPrevalidacion[] {
  const errores: ErrorPrevalidacion[] = [];
  for (const par of PARES_DESTINO) {
    const bi = f.montos.obtener(par.bi);
    const igv = f.montos.obtener(par.igv);
    if (igv.esCero() || igvCuadra(bi, igv, TASA_IGV_18) || igvCuadra(bi, igv, TASA_IGV_10)) continue;
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
    errores: [...tipoCambioFila(f), ...cuadreFila(f), ...igvFila(f), ...origen.errores],
    origen: origen.origen,
  };
}
