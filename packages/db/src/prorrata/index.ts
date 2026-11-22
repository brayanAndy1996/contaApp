// Repositorio de la prorrata (spec 026). Escribe solo por las funciones acotadas de 0066; lee con la RLS del estudio.
export { NO_IMPLEMENTADO, ProrrataRepoError } from "./errores";
export {
  leerDeclaraciones,
  leerUltimaObtencion,
  registrarDeclaraciones,
} from "./declaraciones";
export type {
  DeclaracionFila,
  DeclaracionNueva,
  ObtencionFila,
} from "./declaraciones";
export {
  eliminarMesManual,
  guardarMesManual,
  leerHistorialMes,
  leerManuales,
} from "./manual";
export type { ManualFila } from "./manual";
export { guardarUsada, leerUsada } from "./usada";
export type { UsadaFila } from "./usada";
export { leerTotalesVentasProrrata } from "./ventas";
export type { FilaUsdProrrata, TotalesVentasPeriodo } from "./ventas";
