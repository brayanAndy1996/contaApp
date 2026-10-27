import {
  CorreoNoEnviadoError,
  type Correo,
  type MensajeCorreo,
} from "./correo.js";

/** Lo que usamos de nodemailer; en pruebas es un doble. */
export interface TransporteCorreo {
  sendMail(m: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

export class CorreoSmtp implements Correo {
  private readonly remitente: string;
  private readonly transporte: TransporteCorreo;

  constructor(opciones: { remitente: string; transporte: TransporteCorreo }) {
    this.remitente = opciones.remitente;
    this.transporte = opciones.transporte;
  }

  async enviar(m: MensajeCorreo): Promise<void> {
    try {
      await this.transporte.sendMail({
        from: this.remitente,
        to: m.para,
        subject: m.asunto,
        text: m.texto,
      });
    } catch {
      throw new CorreoNoEnviadoError();
    }
  }
}
