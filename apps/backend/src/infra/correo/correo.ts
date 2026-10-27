export interface MensajeCorreo {
  para: string;
  asunto: string;
  texto: string;
}

/** Puerto de correo saliente (D11). Las implementaciones nunca registran el mensaje. */
export interface Correo {
  enviar(m: MensajeCorreo): Promise<void>;
}

/** Fallo de envío sin `cause` ni texto del transporte (puede contener SMTP_URL, un secreto). */
export class CorreoNoEnviadoError extends Error {
  constructor() {
    super("correo_no_enviado");
    this.name = "CorreoNoEnviadoError";
  }
}
