import {
  CorreoNoEnviadoError,
  type Correo,
  type MensajeCorreo,
} from "./puerto.js";

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

// Controles C0, DEL y C1 (incluye CR, LF, NUL, tabulación y ESC).
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
const ID_INVALIDO = /[\s<>@]|[\u0000-\u001f\u007f-\u009f]/;
const URL_INVALIDA = /[\s<>]|[\u0000-\u001f\u007f-\u009f]/;

/** Dominio del remitente: `a@estudio.pe` o `Nombre <a@estudio.pe>`. */
function dominioDe(remitente: string): string | undefined {
  const m = /@([^@\s<>]+)>?\s*$/.exec(remitente);
  return m?.[1];
}

function bajaPermitida(url: string): boolean {
  if (URL_INVALIDA.test(url)) return false;
  if (url.startsWith("https://") && url.length > "https://".length) return true;
  return (
    process.env.NODE_ENV !== "production" && /^http:\/\/localhost([:/?#]|$)/.test(url)
  );
}

export class CorreoSmtp implements Correo {
  private readonly remitente: string;
  private readonly transporte: TransporteCorreo;

  constructor(opciones: { remitente: string; transporte: TransporteCorreo }) {
    this.remitente = opciones.remitente;
    this.transporte = opciones.transporte;
  }

  async enviar(m: MensajeCorreo): Promise<void> {
    // Las entradas inseguras se rechazan antes del transporte, sin copiarlas en el error (CA-7).
    if (CONTROLES.test(m.para) || CONTROLES.test(m.asunto))
      throw new CorreoNoEnviadoError();
    if (m.baja !== undefined && !bajaPermitida(m.baja.url))
      throw new CorreoNoEnviadoError();
    let messageId: string | undefined;
    if (m.idMensaje !== undefined) {
      const dominio = dominioDe(this.remitente);
      if (m.idMensaje === "" || ID_INVALIDO.test(m.idMensaje) || dominio === undefined)
        throw new CorreoNoEnviadoError();
      messageId = `<${m.idMensaje}@${dominio}>`;
    }
    const mensaje: Parameters<TransporteCorreo["sendMail"]>[0] = {
      from: this.remitente,
      to: m.para,
      subject: m.asunto,
      text: m.texto,
    };
    if (m.html !== undefined) mensaje.html = m.html;
    if (messageId !== undefined) mensaje.messageId = messageId;
    if (m.baja !== undefined)
      mensaje.headers = {
        "List-Unsubscribe": `<${m.baja.url}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      };
    try {
      await this.transporte.sendMail(mensaje);
    } catch {
      throw new CorreoNoEnviadoError();
    }
  }
}
