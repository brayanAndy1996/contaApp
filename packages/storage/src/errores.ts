// Errores propios de @contapp/storage (spec 016). Ningún mensaje incluye la ruta ni el contenido.
export class ArchivoNoEncontradoError extends Error {
  readonly codigo = "storage_no_encontrado";
  constructor() {
    super("Archivo no encontrado en el almacenamiento");
    this.name = "ArchivoNoEncontradoError";
  }
}

export class RutaStorageError extends Error {
  readonly codigo = "storage_ruta_invalida";
  constructor() {
    super("Ruta de almacenamiento inválida");
    this.name = "RutaStorageError";
  }
}

export class ConfiguracionStorageError extends Error {
  readonly codigo = "configuracion_storage";
  readonly variable?: string;
  constructor(mensaje: string, variable?: string) {
    super(mensaje);
    this.name = "ConfiguracionStorageError";
    this.variable = variable;
  }
}
