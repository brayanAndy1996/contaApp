// API pública de prorrata/ (spec 026, plan, Contratos: domain). Los errores, la marca de los meses,
// las centésimas y la división de dinero/ son internos.
export { ventanaProrrata } from "./ventana";
export { porcentajeProrrata } from "./porcentaje";
export type { Porcentaje } from "./porcentaje";
export { resolverMes } from "./meses";
export type {
  AvisoMes,
  FilaUsdSire,
  MesFuente,
  MesProrrata,
  MontosMes,
  OrigenMes,
  Presentacion,
  TotalesSire,
  TotalesSirePen,
} from "./meses";
export { calcularProrrata } from "./coeficiente";
export type {
  AvisoCoeficiente,
  ProrrataCalculada,
  ProrrataFaltanMeses,
  ProrrataNoDeterminable,
  ResultadoProrrata,
} from "./coeficiente";
export { estimarIgv } from "./igv-estimado";
export type { EntradaIgvEstimado, IgvEstimado, SituacionIgv } from "./igv-estimado";
export { compararProrrata } from "./diferencia";
export type { DiferenciaProrrata } from "./diferencia";
