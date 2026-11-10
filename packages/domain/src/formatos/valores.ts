// Valor de cada campo conocido en la línea del TXT (plan 012, Ratificación 4). Lo usan generarTxt,
// para serializar, y prevalidar, para validar contra el formato también los campos que no son
// texto de la fila (fecha, moneda, TC, montos y total; H-012-23): se valida lo mismo que se escribe.
import { COLUMNAS_COMPRA } from "../comprobante/index";
import { esVentaCopia, monedaDe } from "../prevalidacion/entrada";
import type { FilaCopia, FilaTxt, FilaVentaCopia } from "../prevalidacion/entrada";
import { DefinicionFormatoInvalidaError } from "./errores";
import type { CabeceraTxt, Libro, TipoCampo } from "./tipos";

export type Valor = (f: FilaTxt, c: CabeceraTxt) => string;

/** TC aceptado por TipoCambio.desde, completado con ceros a 3 decimales como texto (`3` → `3.000`). */
function tcConTresDecimales(tc: string): string {
  const [entero, decimales = ""] = tc.split(".");
  return `${entero}.${decimales.padEnd(3, "0")}`;
}

/** AAAA-MM-DD (ya validada) → DD/MM/AAAA. */
function fechaTxt(fecha: string): string {
  return `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}/${fecha.slice(0, 4)}`;
}

/**
 * Montos que solo existen en una venta (spec 013, D14b): el resto (`isc`, `icbper`, `total`) es común a
 * los dos libros. Desde 012b se serializan.
 */
const COLUMNAS_SOLO_VENTAS = Object.freeze(["baseGravada", "igv", "exonerada", "inafecta", "otros"] as const);

/**
 * La fila como compra. Un campo propio de compras con una fila de ventas (o sin fila) no tiene valor:
 * es un formato mal definido para ese libro, no un dato que el contador corrija.
 */
function compra(f: FilaTxt | undefined): FilaCopia {
  if (typeof f !== "object" || f === null || esVentaCopia(f)) throw new DefinicionFormatoInvalidaError();
  return f;
}

/** La fila como venta (012b); con una fila de compras (o sin fila) lanza, como `compra`. */
function venta(f: FilaTxt | undefined): FilaVentaCopia {
  if (typeof f !== "object" || f === null || !esVentaCopia(f)) throw new DefinicionFormatoInvalidaError();
  return f;
}

/** Monto común a los dos libros (`isc`, `icbper`, `total`). */
function comun(columna: "isc" | "icbper" | "total"): Valor {
  return (f) => {
    if (esVentaCopia(f)) return f.montos[columna].toString();
    return columna === "total" ? f.montos.total.toString() : f.montos.obtener(columna).toString();
  };
}

/** Valor de cada campo conocido; el texto va tal como llegó. */
export const VALORES: ReadonlyMap<string, Valor> = new Map<string, Valor>([
  ["periodo", (_f, c) => c.periodo],
  ["tipoComprobante", (f) => f.comprobante.tipo],
  ["serie", (f) => f.comprobante.serie],
  ["numero", (f) => f.comprobante.numero],
  ["fechaEmision", (f) => fechaTxt(f.fechaEmision)],
  ["tipoDocProveedor", (f) => compra(f).proveedor.tipo],
  ["numeroDocProveedor", (f) => compra(f).proveedor.numero],
  ["razonSocial", (f) => compra(f).proveedor.razonSocial ?? ""],
  ["moneda", (f) => monedaDe(f)],
  // En PEN va vacío, también con origenUsd (Ratificación 4).
  ["tipoCambio", (f) => (monedaDe(f) === "USD" ? tcConTresDecimales(f.tipoCambio as string) : "")],
  ...COLUMNAS_COMPRA.filter((columna) => columna !== "isc" && columna !== "icbper").map(
    (columna): [string, Valor] => [columna, (f) => compra(f).montos.obtener(columna).toString()],
  ),
  ["isc", comun("isc")],
  ["icbper", comun("icbper")],
  ["total", comun("total")],
]);

/**
 * Valor de los campos que solo existen en una venta (012b): el documento de la contraparte y su tipo
 * (el consumidor final va sin tipo) y los cinco montos propios.
 */
const VALORES_VENTAS: ReadonlyMap<string, Valor> = new Map<string, Valor>([
  ["tipoDocContraparte", (f) => venta(f).contraparte.tipo ?? ""],
  ["docContraparte", (f) => venta(f).contraparte.numero],
  ...COLUMNAS_SOLO_VENTAS.map((columna): [string, Valor] => [columna, (f) => venta(f).montos[columna].toString()]),
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
  // Solo los ventas reconocen estos cinco (valorDeCampo los rechaza en compras).
  ...COLUMNAS_SOLO_VENTAS.map((columna): [string, TipoCampo] => [columna, "monto"]),
]);

/**
 * Serializador del campo `nombre`. Lanza DefinicionFormatoInvalidaError si generarTxt no sabe
 * escribirlo: RegistroFormatos.desde lo usa para rechazar ese campo al registrar, así que todo
 * campo de un formato registrado tiene valor y «apto» siempre quiere decir «genera» (D21, H-012-24).
 */
export function valorDeCampo(nombre: string, libro: Libro = "compras"): Valor {
  const valor = VALORES.get(nombre);
  if (valor !== undefined) return valor;
  // Los campos propios de ventas (013) solo valen en ese libro; desde 012b se serializan.
  const deVentas = libro === "ventas" ? VALORES_VENTAS.get(nombre) : undefined;
  if (deVentas !== undefined) return deVentas;
  throw new DefinicionFormatoInvalidaError();
}
