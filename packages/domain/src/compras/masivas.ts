// Qué sugerencias se aceptan en masa (spec 014, D-15, DU-6, DU-15): solo las que no piden confirmación
// ni dato. Con las reglas de 011, R-RED respaldada por el XML, R-ISC respaldada por el XML y R-MIX con
// monto exacto del XML; R-RED por umbral sin XML (pide confirmación) va una por una.
import type { Hallazgo } from "../reglas/index";

export function sugerenciaEsMasiva(hallazgo: Hallazgo): boolean {
  return hallazgo.sugerencia !== null && !hallazgo.requiereConfirmacion && hallazgo.dato === null;
}
