// API pública de comprobante/ (plan 010, Contratos). No exporta los accesos internos
// (montosDesdeColumnas, copiarColumnas) ni las ayudas de columnas.
export { COLUMNAS_COMPRA } from "./columnas";
export type { ColumnaCompra, Destino } from "./columnas";
export { MontosComprobante } from "./montos-comprobante";
export { cambiarDestino } from "./cambiar-destino";
export { moverMonto } from "./mover-monto";
export { convertirAPen } from "./convertir";
