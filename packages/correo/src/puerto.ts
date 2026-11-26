/** Mensaje de correo saliente. Spec 028 (plan, Contratos: correo). */
export interface MensajeCorreo {
  para: string;
  asunto: string;
  texto: string;
  /** Versión HTML (multiparte con `texto`). */
  html?: string;
  /** Enlace de baja: agrega las cabeceras de RFC 8058. La URL lleva un token: nunca se registra. */
  baja?: { url: string };
  /** Id del envío: da el `Message-ID` estable para los reintentos. */
  idMensaje?: string;
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

/**
 * Configuración incompleta de `crearCorreo`; `variable` es el nombre de la variable de entorno que falta.
 * El mensaje no incluye valores (la URL SMTP puede llevar una clave).
 */
export class CorreoConfigInvalidaError extends Error {
  readonly variable: "CORREO_REMITENTE" | "SMTP_URL";
  constructor(variable: "CORREO_REMITENTE" | "SMTP_URL") {
    super(`configuracion_de_correo_invalida:${variable}`);
    this.name = "CorreoConfigInvalidaError";
    this.variable = variable;
  }
}
