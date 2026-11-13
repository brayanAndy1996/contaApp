// Repositorio de reglas aprendidas (spec 021). Solo SQL en la `tx` de withTenant; `packages/db` no depende de `domain`: R-HIS se
// decide en el dominio y llega a `insertarCompras` como función inyectada (`historial`).
export { esUuidRegla, leerRegla, listarReglas } from "./lectura";
export { editarRegla, eliminarRegla, recordarRegla } from "./escritura";
export { fijarAporte, fijarReglaMotor, leerReglasMotor } from "./motor";
export { aplicarReglaHistorial, datosHistorial, reglasHistorialVigentes } from "./aplicar";
export type {
  CodigoRegla,
  DestinoRegla,
  EntradaEditar,
  EntradaEliminar,
  EntradaRecordar,
  LecturaMotor,
  ReglaFila,
  ReglaVigente,
} from "./tipos";
