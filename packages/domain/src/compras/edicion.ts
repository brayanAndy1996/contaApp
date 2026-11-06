// Edición de montos de una compra con total y cuadre por celda (spec 014, D-5 y D-16). Una sola función
// para editar y para la vista previa de `calcular`: así las dos dan siempre lo mismo.
import { COLUMNAS_COMPRA, MontosComprobante } from "../comprobante/index";
import type { ColumnaCompra } from "../comprobante/index";
import { esColumnaCompra } from "../comprobante/columnas";
import { MontoInvalidoError, Money } from "../dinero/index";
import { igvAceptable } from "../prevalidacion/aritmetica";
import { igvNoCuadra } from "../prevalidacion/explicaciones";
import { PARES_DESTINO } from "../reglas/entrada";

/** Cadenas decimales por columna; el total no se edita (es Σ de las componentes). */
export type CambiosMontos = Partial<Record<ColumnaCompra, string>>;

export interface CeldaCuadre {
  readonly columna: ColumnaCompra;
  readonly cuadra: boolean;
  /** `null` si cuadra; si no, el texto con las cifras. */
  readonly explicacion: string | null;
}

export interface CuadreEdicion {
  readonly cuadra: boolean;
  /** Una celda por columna de IGV (igvDg, igvDgng, igvDng). */
  readonly celdas: readonly CeldaCuadre[];
}

export interface ResultadoEdicion {
  readonly montos: MontosComprobante;
  readonly total: Money;
  readonly cuadre: CuadreEdicion;
}

/**
 * Sustituye solo las columnas nombradas, recalcula el total como Σ de las 10 componentes (D2 de 010) y
 * revisa el IGV de cada destino con la regla de 012. Un IGV descuadrado se devuelve señalado, no lanza.
 * Lanza DineroError ante una clave que no es columna, un valor que no es cadena, más de 2 decimales o un
 * monto o total fuera de NUMERIC(14,2).
 */
export function aplicarEdicion(montos: MontosComprobante, cambios: CambiosMontos): ResultadoEdicion {
  if (typeof cambios !== "object" || cambios === null || Array.isArray(cambios)) throw new MontoInvalidoError();
  for (const clave of Object.keys(cambios)) {
    if (!esColumnaCompra(clave)) throw new MontoInvalidoError();
  }
  const moneda = montos.moneda;
  const columnas = {} as Record<ColumnaCompra, Money>;
  for (const c of COLUMNAS_COMPRA) {
    columnas[c] = Object.hasOwn(cambios, c) ? Money.desde(cambios[c] as string, moneda) : montos.obtener(c);
  }
  const total = Money.suma(COLUMNAS_COMPRA.map((c) => columnas[c]), moneda);
  const textos = {} as Record<ColumnaCompra, string>;
  for (const c of COLUMNAS_COMPRA) textos[c] = columnas[c].toString();
  const nuevos = MontosComprobante.desde(moneda, { ...textos, total: total.toString() });

  const celdas = PARES_DESTINO.map((par): CeldaCuadre => {
    const bi = columnas[par.bi];
    const igv = columnas[par.igv];
    const cuadra = igvAceptable(bi, igv);
    return { columna: par.igv, cuadra, explicacion: cuadra ? null : igvNoCuadra(igv, bi) };
  });
  return { montos: nuevos, total, cuadre: { cuadra: celdas.every((c) => c.cuadra), celdas } };
}
