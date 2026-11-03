// Errores de los repositorios de clientes (spec 007a, D4 y D5). Sin datos de entrada ni rastro del error de `pg`:
// el servicio los traduce a 409 `ruc_duplicado` y 409 `cliente_archivado`.

/** El RUC ya existe en el estudio (también si el existente está archivado): unique (tenant_id, ruc). */
export class RucDuplicadoError extends Error {
  constructor() {
    super("RUC duplicado en el estudio");
  }
}

/** El cliente está archivado y en solo lectura (editar o asignar). */
export class ClienteArchivadoError extends Error {
  constructor() {
    super("Cliente archivado");
  }
}

// En el prototipo (no como propiedad propia): ningún error lleva claves propias.
for (const [clase, nombre] of [
  [RucDuplicadoError, "RucDuplicadoError"],
  [ClienteArchivadoError, "ClienteArchivadoError"],
] as const) {
  Object.defineProperty(clase.prototype, "name", {
    value: nombre,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
