/* eslint-disable @typescript-eslint/no-unused-vars -- stub de T1: T7 usa los parámetros */
// Stub de T1 (spec 012b, rojo). T7 implementa los adaptadores de fila con D7.
import type { FilaReemplazo, FilaReemplazoVenta } from "../prevalidacion/index";
import type { AvisoArchivo, CompraLeidaPlana, VentaLeidaPlana } from "./tipos";

/** Compra de 014 → fila de 012. D7: razón social > 100 puntos de código se recorta y emite `RAZON_SOCIAL_RECORTADA`. */
export function compraLeidaAFila(_c: CompraLeidaPlana): { fila: FilaReemplazo; avisos: AvisoArchivo[] } {
  throw new Error("no implementado");
}

/** Venta de 013 → fila de ventas: `excluida` → `excluida`; `manual` → `agregada`; `sire` → `original`. */
export function ventaAFila(_v: VentaLeidaPlana): FilaReemplazoVenta {
  throw new Error("no implementado");
}
