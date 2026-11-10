// Prevalidación de una fila de ventas (spec 012b, D1, D12, P-6, P-8; plan, Contratos: Dominio). Es la
// única verdad de «esta venta tiene error»: la usa `prevalidar` por dentro y el servidor, con
// `erroresDeFilaVenta`, para decidir si una venta del SIRE es excluible. Sin las reglas de 011: el IGV se
// mira sobre `baseGravada` (18 % o 10 %, como igvAceptable de compras) y el cuadre es exacto (cuadraVenta).
import type { Cuadrable, Money } from "../dinero/index";
import { seleccionarFormato } from "../formatos/registro";
import type { CabeceraTxt, FormatoTxt } from "../formatos/tipos";
import { COMPONENTES_VENTA } from "../ventas/columnas";
import { erroresCuadre, erroresTipoCambio, igvAceptable } from "./aritmetica";
import { compararErrores, invalida, leerCabecera, leerFilasVenta } from "./entrada";
import type { FilaVentaCopia } from "./entrada";
import { crearError } from "./errores";
import { validarEstructura } from "./estructura";
import { igvNoCuadra } from "./explicaciones";
import type { ErrorPrevalidacion, FilaReemplazoVenta } from "./tipos";

/** Las siete columnas que componen el total, en la moneda de la venta. */
function cuadrable(f: FilaVentaCopia): Cuadrable {
  const componentes: readonly Money[] = Object.freeze(COMPONENTES_VENTA.map((c) => f.montos[c]));
  return { moneda: f.moneda, total: f.montos.total, componentes: () => componentes };
}

/** IGV sobre la base gravada: 0.00, o del mismo signo que la base y a 18 % o 10 % (±0.01). */
function igvVenta(f: FilaVentaCopia): ErrorPrevalidacion[] {
  const { baseGravada, igv } = f.montos;
  if (igvAceptable(baseGravada, igv)) return [];
  return [crearError({ filaId: f.id, codigo: "IGV", campo: "igv", explicacion: igvNoCuadra(igv, baseGravada) })];
}

/**
 * Errores de la propia fila: estructura y fecha contra el formato, tipo de cambio, cuadre e IGV. Sin
 * DUPLICADO ni SIN_FILAS (miran otras filas) ni los de la cabecera. Sin ordenar.
 */
export function erroresDeVentaCopia(f: FilaVentaCopia, formato: FormatoTxt, cabecera: CabeceraTxt): ErrorPrevalidacion[] {
  return [
    ...validarEstructura(f, formato, cabecera),
    ...erroresTipoCambio(f.id, f.moneda, f.tipoCambio),
    ...erroresCuadre(f.id, cuadrable(f)),
    ...igvVenta(f),
  ];
}

/**
 * Errores de prevalidación de la propia fila (sin DUPLICADO, SIN_FILAS ni los de la cabecera), en el
 * orden de `prevalidar`. Plan 012b, Contratos: Dominio. Una fila válida da []; la cabecera debe ser de
 * ventas y la fila, de ventas (si no, EntradaPrevalidacionInvalidaError). No mira el `estado`.
 */
export function erroresDeFilaVenta(cabecera: CabeceraTxt, fila: FilaReemplazoVenta): ErrorPrevalidacion[] {
  const cab = leerCabecera(cabecera);
  if (cab.libro !== "ventas") invalida();
  const [copia] = leerFilasVenta([fila]) as [FilaVentaCopia];
  const formato = seleccionarFormato(cab.libro, cab.periodo);
  return erroresDeVentaCopia(copia, formato, cab).sort(compararErrores);
}
