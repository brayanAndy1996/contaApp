// Repositorio de reglas aprendidas (spec 021). Solo SQL en la `tx` de withTenant; `packages/db` no depende de `domain`: R-HIS se
// decide en el dominio y llega a `insertarCompras` como función inyectada (`historial`).
export { esUuidRegla, leerProveedoresConRegla, leerRegla, listarReglas } from "./lectura";
export { editarRegla, eliminarRegla, recordarRegla } from "./escritura";
export { fijarAporte, fijarReglaMotor, leerReglasMotor } from "./motor";
export { aplicarReglaHistorial, aplicarReglasHistorial, datosHistorial, LOTE_HISTORIAL, reglasHistorialVigentes } from "./aplicar";
export type { AplicacionHistorial } from "./aplicar";
export type {
  CodigoRegla,
  DestinoRegla,
  EntradaEditar,
  EntradaEliminar,
  EntradaRecordar,
  LecturaMotor,
  OrigenRegla,
  ReglaFila,
  ReglaVigente,
} from "./tipos";
