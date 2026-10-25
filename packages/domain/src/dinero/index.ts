// API pública de dinero/ (plan 010, Contratos). Nunca exporta Decimal, D ni los
// accesos internos (decimalDe*, *DesdeDecimal).
export {
  DineroError,
  FactorInvalidoError,
  MonedaDistintaError,
  MontoFueraDeRangoError,
  MontoInvalidoError,
  MovimientoInvalidoError,
} from "./errores";
export type { Moneda } from "./moneda";
export { Money } from "./money";
export { MontoExacto } from "./monto-exacto";
export { Factor } from "./factor";
export { TipoCambio } from "./tipo-cambio";
export { redondearSunat } from "./redondeo";
export { Tolerancia, TOLERANCIA_CUADRE, TOLERANCIA_IGV } from "./tolerancia";
export { TASA_IGV_10, TASA_IGV_18, igvCuadra, igvEsperado } from "./igv";
export type { TasaIgv } from "./igv";
export { verificarCuadre } from "./cuadre";
export type { Cuadrable, ResultadoCuadre } from "./cuadre";
