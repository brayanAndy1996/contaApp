// Columnas de montos de una venta (spec 013, D14b): base gravada, IGV, exonerada, inafecta, ISC,
// ICBPER, otros y total, todas NUMERIC(14,2). El total no es componente: lo suman las otras siete.
export type ColumnaVenta = "baseGravada" | "igv" | "exonerada" | "inafecta" | "isc" | "icbper" | "otros" | "total";
export type ComponenteVenta = Exclude<ColumnaVenta, "total">;

/** Las siete columnas que componen el total, en el orden del cuadre. */
export const COMPONENTES_VENTA: readonly ComponenteVenta[] = Object.freeze([
  "baseGravada",
  "igv",
  "exonerada",
  "inafecta",
  "isc",
  "icbper",
  "otros",
] as const);

/** Las ocho columnas de monto. */
export const COLUMNAS_VENTA: readonly ColumnaVenta[] = Object.freeze([...COMPONENTES_VENTA, "total"] as const);

export type MontosVenta = Readonly<Record<ColumnaVenta, string>>;
