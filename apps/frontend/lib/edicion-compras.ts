import {
  COLUMNAS_MONTO_COMPRA,
  type ColumnaMontoCompra,
  type CuadreCompra,
  type FilaCompraVista,
} from "@contapp/shared";
import { MENSAJES_COMPRAS as M } from "./compras";
import { MOTIVOS_MONTO, iguales, sumar, validarMonto } from "./montos-compras";

// Estado puro de la edición de una fila de compras (spec 015, T6; D-3, D-6, P-3). Sin DOM ni red: la grilla solo
// dibuja este estado y llama a `calcular`/`editar`. Todo monto es una cadena decimal; las sumas pasan por
// `montos-compras.ts` (decimal.js) y ningún `number` cruza la frontera. El navegador solo calcula el total que
// muestra mientras se teclea: lo que se guarda lo recalcula y valida el servidor (014 D-5, D-16).

/** Columnas editables: las 10 de monto. El total, la fecha, el proveedor y la moneda no se editan. */
export const COLUMNAS_EDITABLES: readonly ColumnaMontoCompra[] = COLUMNAS_MONTO_COMPRA;

export type MontosColumnas = Record<ColumnaMontoCompra, string>;
export type CambiosFila = Partial<Record<ColumnaMontoCompra, string>>;

export interface EstadoEdicion {
  filaId: string;
  /** Versión de la fila al empezar a editar: el `editar` la envía para detectar cambios de otra persona. */
  versionBase: number;
  /** Las 10 columnas tal como las trajo el servidor. */
  original: MontosColumnas;
  /** Texto de las celdas que el usuario tocó (puede ser inválido: se explica y no se envía). */
  borrador: CambiosFila;
  /** Último cuadre que respondió `calcular` para este borrador; `null` si aún no hay. */
  cuadre: CuadreCompra | null;
  /** `calcular` falló: se mantiene el total local y se avisa «cuadre no verificado». */
  cuadreNoVerificado: boolean;
}

export const esColumnaEditable = (id: string): id is ColumnaMontoCompra =>
  (COLUMNAS_EDITABLES as readonly string[]).includes(id);

export function iniciarEdicion(fila: FilaCompraVista): EstadoEdicion {
  const original = {} as MontosColumnas;
  for (const c of COLUMNAS_EDITABLES) original[c] = fila.montos[c];
  return {
    filaId: fila.id,
    versionBase: fila.version,
    original,
    borrador: {},
    cuadre: null,
    cuadreNoVerificado: false,
  };
}

/** Texto que muestra la celda: lo tecleado si la tocó, si no el valor del servidor. */
export const textoDe = (estado: EstadoEdicion, columna: ColumnaMontoCompra): string =>
  estado.borrador[columna] ?? estado.original[columna];

export function cambiarCelda(
  estado: EstadoEdicion,
  columna: ColumnaMontoCompra,
  texto: string,
): EstadoEdicion {
  return { ...estado, borrador: { ...estado.borrador, [columna]: texto } };
}

/** Por qué la celda no se puede enviar (más de 2 decimales, signo, formato…), o `null` si está bien o no se tocó. */
export function errorDeCelda(
  estado: EstadoEdicion,
  columna: ColumnaMontoCompra,
): string | null {
  const texto = estado.borrador[columna];
  if (texto === undefined) return null;
  const r = validarMonto(texto);
  if (r.ok) return null;
  return r.motivo === MOTIVOS_MONTO.decimales ? M.montoMasDeDosDecimales : r.motivo;
}

/** Valor que cuenta en el total: lo tecleado si es válido; una celda inválida cuenta con su valor original. */
function valorDe(estado: EstadoEdicion, columna: ColumnaMontoCompra): string {
  const texto = estado.borrador[columna];
  if (texto !== undefined) {
    const r = validarMonto(texto);
    if (r.ok) return r.valor;
  }
  return estado.original[columna];
}

/** Total en pantalla mientras se teclea: suma exacta de las 10 columnas (D-6). El servidor lo recalcula al guardar. */
export const totalLocal = (estado: EstadoEdicion): string =>
  sumar(COLUMNAS_EDITABLES.map((c) => valorDe(estado, c)));

/**
 * Lo que se enviaría: solo las celdas válidas y distintas del original (`editar` y `calcular`), y las columnas
 * con un monto inválido, que bloquean el guardado (no se envía nada hasta corregirlas).
 */
export function cambiosParaEnviar(estado: EstadoEdicion): {
  cambios: CambiosFila;
  invalidas: ColumnaMontoCompra[];
} {
  const cambios: CambiosFila = {};
  const invalidas: ColumnaMontoCompra[] = [];
  for (const c of COLUMNAS_EDITABLES) {
    const texto = estado.borrador[c];
    if (texto === undefined) continue;
    const r = validarMonto(texto);
    if (!r.ok) invalidas.push(c);
    else if (!iguales(r.valor, estado.original[c])) cambios[c] = r.valor;
  }
  return { cambios, invalidas };
}

export const hayCambios = (estado: EstadoEdicion): boolean => {
  const { cambios, invalidas } = cambiosParaEnviar(estado);
  return invalidas.length > 0 || Object.keys(cambios).length > 0;
};

export const aplicarCuadre = (estado: EstadoEdicion, cuadre: CuadreCompra): EstadoEdicion => ({
  ...estado,
  cuadre,
  cuadreNoVerificado: false,
});

/** `calcular` falló: se conserva el total local y se avisa que el cuadre no se pudo verificar. */
export const marcarCuadreNoVerificado = (estado: EstadoEdicion): EstadoEdicion => ({
  ...estado,
  cuadre: null,
  cuadreNoVerificado: true,
});

/** Sin cambios que verificar (se volvió al original): no hay cuadre que mostrar. */
export const sinCuadre = (estado: EstadoEdicion): EstadoEdicion => ({
  ...estado,
  cuadre: null,
  cuadreNoVerificado: false,
});

export interface ExplicacionCelda {
  columna: ColumnaMontoCompra;
  /** `monto`: no se puede enviar; `cuadre`: el servidor dice que no cuadra (no impide guardar). */
  tipo: "monto" | "cuadre";
  texto: string;
}

/** Todo lo que la pantalla debe explicar de la fila en edición, en el orden de las columnas. */
export function explicaciones(estado: EstadoEdicion): ExplicacionCelda[] {
  const lista: ExplicacionCelda[] = [];
  for (const c of COLUMNAS_EDITABLES) {
    const error = errorDeCelda(estado, c);
    if (error !== null) {
      lista.push({ columna: c, tipo: "monto", texto: error });
      continue;
    }
    const celda = estado.cuadre?.celdas.find((x) => x.columna === c && !x.cuadra);
    if (celda) lista.push({ columna: c, tipo: "cuadre", texto: celda.explicacion ?? M.descuadre });
  }
  return lista;
}
