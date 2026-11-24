// STUB (spec 028 T2, rojo).
import type { Correo, MensajeCorreo } from "./puerto.js";

/** Lo que usamos de nodemailer; en pruebas es un doble. */
export interface TransporteCorreo {
  sendMail(m: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    messageId?: string;
    headers?: Record<string, string>;
  }): Promise<unknown>;
}

export class CorreoSmtp implements Correo {
  constructor(_opciones: { remitente: string; transporte: TransporteCorreo }) {
    throw new Error("no implementado: CorreoSmtp");
  }

  enviar(_m: MensajeCorreo): Promise<void> {
    throw new Error("no implementado: CorreoSmtp.enviar");
  }
}
