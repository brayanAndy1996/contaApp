// API pública de ventas/ (spec 013, plan, Contratos: Dominio). Las columnas y los helpers son internos.
export { resumirVentas } from "./resumen";
export type { FilaResumenVenta, ResumenVentas, TotalesPorTipo, TotalesVenta, VentaSinConvertir } from "./resumen";
export { LAYOUT_VENTAS_PROVISIONAL, cuadraVenta, validarFilaVenta } from "./layout";
export type { ColumnaLayout, ErrorFilaVenta, FilaVentaValida, LayoutVentas, ResultadoFilaVenta } from "./layout";
export type { ColumnaVenta, MontosVenta } from "./columnas";
