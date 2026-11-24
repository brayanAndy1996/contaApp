// STUB (spec 028 T2, rojo): contrato de plan.md (Contratos: correo). La implementación es de T9 (mover desde apps/backend/src/infra/correo/).
export interface MensajeCorreo {
  para: string;
  asunto: string;
  texto: string;
  html?: string;
  baja?: { url: string };
  idMensaje?: string;
}

export interface Correo {
  enviar(m: MensajeCorreo): Promise<void>;
}

/** Fallo de envío sin `cause` ni texto del transporte. */
export class CorreoNoEnviadoError extends Error {
  constructor() {
    super("no implementado");
    throw new Error("no implementado: CorreoNoEnviadoError");
  }
}

/** Configuración incompleta de `crearCorreo`; `variable` es el nombre de la variable de entorno que falta. */
export class CorreoConfigInvalidaError extends Error {
  readonly variable: "CORREO_REMITENTE" | "SMTP_URL";
  constructor(variable: "CORREO_REMITENTE" | "SMTP_URL") {
    super("no implementado");
    this.variable = variable;
    throw new Error("no implementado: CorreoConfigInvalidaError");
  }
}
