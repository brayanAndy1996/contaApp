// Error interno de las plantillas de correo (spec 028). Mensaje fijo: nunca incluye el valor recibido. Un error aquí es un defecto de
// quien llama (el worker arma la entrada desde la BD), no una entrada del usuario; no se exporta del índice del paquete.

export class ErrorCorreo extends Error {
  readonly campo: string;

  constructor(campo: string) {
    super(`Entrada de correo inválida: ${campo}.`);
    this.name = "ErrorCorreo";
    this.campo = campo;
  }
}
