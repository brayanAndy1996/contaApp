// Texto canónico de la huella (spec 012b, P-2, D4, D12; plan, Contratos: Dominio). Versión «h1»: la
// cabecera, el formato y cada fila de las dos listas, en orden de id, con su estado y todos los campos que
// van al TXT o al resumen; montos con su escala fija (Money.toString). Cada parte va como arreglo JSON, así
// que dos entradas distintas no colisionan por concatenación. No entran los avisos (el `xml` de una compra),
// el estado del periodo ni el motivo de una exclusión. La huella es `sha256Hex(canon)`, fuera del dominio.
import { COLUMNAS_COMPRA } from "../comprobante/index";
import type { CabeceraTxt } from "../formatos/tipos";
import { compararTexto, esVentaCopia, invalida, leerCabecera, leerFilasDe, leerObjeto } from "../prevalidacion/entrada";
import type { FilaCopia, FilaTxt, FilaVentaCopia } from "../prevalidacion/entrada";
import { COLUMNAS_VENTA } from "../ventas/columnas";
import type { EntradaCanonHuella } from "./tipos";

const VERSION = "h1";
const CLAVES_ENTRADA = ["cabecera", "formato", "original", "vigente"];
const CLAVES_FORMATO = ["id", "version", "oficial"];

export interface FormatoHuella {
  readonly id: string;
  readonly version: string;
  readonly oficial: boolean;
}

function filaCompra(f: FilaCopia): readonly unknown[] {
  const { comprobante: c, proveedor: p, montos: m, origenUsd: o } = f;
  return [
    f.id,
    f.estado,
    c.tipo,
    c.serie,
    c.numero,
    p.tipo,
    p.numero,
    p.razonSocial,
    f.fechaEmision,
    m.moneda,
    [...COLUMNAS_COMPRA.map((col) => m.obtener(col).toString()), m.total.toString()],
    f.tipoCambio,
    o === null ? null : [o.montos.moneda, ...COLUMNAS_COMPRA.map((col) => o.montos.obtener(col).toString()), o.montos.total.toString(), o.tipoCambio],
  ];
}

function filaVenta(f: FilaVentaCopia): readonly unknown[] {
  const { comprobante: c, contraparte: p } = f;
  return [
    f.id,
    f.estado,
    c.tipo,
    c.serie,
    c.numero,
    p.tipo,
    p.numero,
    f.fechaEmision,
    f.moneda,
    COLUMNAS_VENTA.map((col) => f.montos[col].toString()),
    f.tipoCambio,
  ];
}

function filas(lista: readonly FilaTxt[]): readonly (readonly unknown[])[] {
  return [...lista]
    .sort((a, b) => compararTexto(a.id, b.id))
    .map((f) => (esVentaCopia(f) ? filaVenta(f) : filaCompra(f)));
}

/** Canon sobre copias ya leídas (prepararArchivo lee una sola vez). */
export function canonDeCopias(
  cabecera: CabeceraTxt,
  formato: FormatoHuella,
  original: readonly FilaTxt[],
  vigente: readonly FilaTxt[],
): string {
  const cuerpo = JSON.stringify([
    [cabecera.rucDeclarante, cabecera.periodo, cabecera.libro],
    [formato.id, formato.version, formato.oficial],
    filas(original),
    filas(vigente),
  ]);
  return `${VERSION}\n${cuerpo}`;
}

function leerFormato(o: unknown): FormatoHuella {
  const v = leerObjeto(o, CLAVES_FORMATO);
  const id = v.get("id");
  const version = v.get("version");
  const oficial = v.get("oficial");
  if (typeof id !== "string" || typeof version !== "string" || typeof oficial !== "boolean") invalida();
  return { id, version, oficial };
}

/**
 * Texto canónico «h1» de la huella. Determinista y sin depender del orden de entrada. Libro y filas
 * deben coincidir (las del otro libro → EntradaPrevalidacionInvalidaError). No muta la entrada.
 */
export function canonHuella(e: EntradaCanonHuella): string {
  const v = leerObjeto(e, CLAVES_ENTRADA);
  const cabecera = leerCabecera(v.get("cabecera"));
  const formato = leerFormato(v.get("formato"));
  const original = leerFilasDe(cabecera.libro, v.get("original"));
  const vigente = leerFilasDe(cabecera.libro, v.get("vigente"));
  return canonDeCopias(cabecera, formato, original, vigente);
}
