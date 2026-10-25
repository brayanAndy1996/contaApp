// Columnas de montos del registro de compras (D4) y destinos de la adquisición.
export type ColumnaCompra =
  | "biDg"
  | "igvDg"
  | "biDgng"
  | "igvDgng"
  | "biDng"
  | "igvDng"
  | "noGravado"
  | "isc"
  | "icbper"
  | "otrosTributos";

/** Este orden es el de MontosComprobante.componentes() y toJSON().columnas. */
export const COLUMNAS_COMPRA: readonly ColumnaCompra[] = Object.freeze([
  "biDg",
  "igvDg",
  "biDgng",
  "igvDgng",
  "biDng",
  "igvDng",
  "noGravado",
  "isc",
  "icbper",
  "otrosTributos",
] as const);

export type Destino = "DG" | "DGNG" | "DNG";

/** Orden fijo de los destinos (el de `consolidados`). */
export const DESTINOS: readonly Destino[] = Object.freeze(["DG", "DGNG", "DNG"] as const);

/** Par BI/IGV de cada destino. */
export const PAR_DESTINO: Readonly<Record<Destino, { readonly bi: ColumnaCompra; readonly igv: ColumnaCompra }>> =
  Object.freeze({
    DG: Object.freeze({ bi: "biDg", igv: "igvDg" }),
    DGNG: Object.freeze({ bi: "biDgng", igv: "igvDgng" }),
    DNG: Object.freeze({ bi: "biDng", igv: "igvDng" }),
  });

const CONJUNTO_COLUMNAS: ReadonlySet<string> = new Set(COLUMNAS_COMPRA);
const CONJUNTO_DESTINOS: ReadonlySet<string> = new Set(DESTINOS);

export function esColumnaCompra(c: unknown): c is ColumnaCompra {
  return typeof c === "string" && CONJUNTO_COLUMNAS.has(c);
}

export function esDestino(d: unknown): d is Destino {
  return typeof d === "string" && CONJUNTO_DESTINOS.has(d);
}
