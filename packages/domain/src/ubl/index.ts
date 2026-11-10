// API pública de ubl/ (spec 016, plan «Contratos: Dominio»): parser UBL seguro, identidad y resumen para las reglas.
export { leerUbl } from "./leer";
export { aResumenXml } from "./resumen";
export { compararIdentidad } from "./identidad";
export type { CampoIdentidad, CompraIdentificable, ResultadoIdentidad } from "./identidad";
export { UblError } from "./tipos";
export type { AfectacionXml, CodigoUbl, DetalleXml, IdentidadXml, ItemXml, RaizUbl, TotalesXml } from "./tipos";
