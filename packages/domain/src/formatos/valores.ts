// Valor de cada campo conocido en la línea del TXT (plan 012, Ratificación 4). Lo usan generarTxt,
// para serializar, y prevalidar, para validar contra el formato también los campos que no son
// texto de la fila (fecha, moneda, TC, montos y total; H-012-23): se valida lo mismo que se escribe.
import { COLUMNAS_COMPRA } from "../comprobante/index";
import type { FilaCopia } from "../prevalidacion/entrada";
import { DefinicionFormatoInvalidaError } from "./errores";
import type { CabeceraTxt, TipoCampo } from "./tipos";

export type Valor = (f: FilaCopia, c: CabeceraTxt) => string;

/** TC aceptado por TipoCambio.desde, completado con ceros a 3 decimales como texto (`3` → `3.000`). */
function tcConTresDecimales(tc: string): string {
  const [entero, decimales = ""] = tc.split(".");
  return `${entero}.${decimales.padEnd(3, "0")}`;
}

/** AAAA-MM-DD (ya validada) → DD/MM/AAAA. */
function fechaTxt(fecha: string): string {
  return `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}/${fecha.slice(0, 4)}`;
}

/** Valor de cada campo conocido; el texto va tal como llegó. */
export const VALORES: ReadonlyMap<string, Valor> = new Map<string, Valor>([
  ["periodo", (_f, c) => c.periodo],
  ["tipoComprobante", (f) => f.comprobante.tipo],
  ["serie", (f) => f.comprobante.serie],
  ["numero", (f) => f.comprobante.numero],
  ["fechaEmision", (f) => fechaTxt(f.fechaEmision)],
  ["tipoDocProveedor", (f) => f.proveedor.tipo],
  ["numeroDocProveedor", (f) => f.proveedor.numero],
  ["razonSocial", (f) => f.proveedor.razonSocial ?? ""],
  ["moneda", (f) => f.montos.moneda],
  // En PEN va vacío, también con origenUsd (Ratificación 4).
  ["tipoCambio", (f) => (f.montos.moneda === "USD" ? tcConTresDecimales(f.tipoCambio as string) : "")],
  ...COLUMNAS_COMPRA.map((columna): [string, Valor] => [columna, (f) => f.montos.obtener(columna).toString()]),
  ["total", (f) => f.montos.total.toString()],
]);

/**
 * Tipo de cada campo de valor fijo: lo escribe el sistema (periodo, fecha, moneda, TC, montos y
 * total), no el texto de la fila, así que su `tipo` solo puede ser el de ese valor. Uno distinto
 * (p. ej. un monto `ruc`) haría fallar toda fila con un error que nadie puede corregir (H-012-61).
 * Los campos de texto de la fila (serie, documento, razón social…) no tienen un tipo fijo.
 */
export const TIPOS_FIJOS: ReadonlyMap<string, TipoCampo> = new Map<string, TipoCampo>([
  ["periodo", "codigo"],
  ["fechaEmision", "fecha"],
  ["moneda", "codigo"],
  ["tipoCambio", "tc"],
  ...COLUMNAS_COMPRA.map((columna): [string, TipoCampo] => [columna, "monto"]),
  ["total", "monto"],
]);

/**
 * Serializador del campo `nombre`. Lanza DefinicionFormatoInvalidaError si generarTxt no sabe
 * escribirlo: RegistroFormatos.desde lo usa para rechazar ese campo al registrar, así que todo
 * campo de un formato registrado tiene valor y «apto» siempre quiere decir «genera» (D21, H-012-24).
 */
export function valorDeCampo(nombre: string): Valor {
  const valor = VALORES.get(nombre);
  if (valor === undefined) throw new DefinicionFormatoInvalidaError();
  return valor;
}
