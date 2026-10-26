import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CorreoSmtp } from "./smtp.js";

// D11 (spec 004). Contrato (plan: Decisiones: Correo):
//   new CorreoSmtp({ remitente: string, transporte: { sendMail(m: { from, to, subject, text }): Promise<unknown> } })
//   El transporte se inyecta (en despliegue es nodemailer con SMTP_URL; en pruebas, un doble).
//   enviar({ para, asunto, texto }) -> sendMail({ from: remitente, to: para, subject: asunto, text: texto }).
//   Si el transporte falla, enviar rechaza con un error SIN `cause` y sin copiar el mensaje del
//   transporte (puede contener SMTP_URL, un secreto).
const MENSAJE = { para: "ana@estudio.pe", asunto: "Hola", texto: "Cuerpo del correo" };

describe("CorreoSmtp", () => {
  it("envía por el transporte con remitente, destinatario, asunto y texto", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "m1" }));
    const correo = new CorreoSmtp({ remitente: "no-responder@estudio.pe", transporte: { sendMail } });
    await correo.enviar(MENSAJE);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: "no-responder@estudio.pe",
      to: "ana@estudio.pe",
      subject: "Hola",
      text: "Cuerpo del correo",
    });
  });

  it("resuelve sin valor cuando el transporte acepta el mensaje", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "m1", accepted: ["ana@estudio.pe"] }));
    const correo = new CorreoSmtp({ remitente: "no-responder@estudio.pe", transporte: { sendMail } });
    await expect(correo.enviar(MENSAJE)).resolves.toBeUndefined();
  });

  it("si el transporte falla, rechaza sin `cause` ni el texto del error original", async () => {
    const canario = "CANARIO-SMTP-URL-77";
    const origen = new Error(`connect ECONNREFUSED smtp://usuario:${canario}@correo.interno:587`);
    const sendMail = vi.fn(async () => {
      throw origen;
    });
    const correo = new CorreoSmtp({ remitente: "no-responder@estudio.pe", transporte: { sendMail } });
    const error = await correo.enviar(MENSAJE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const e = error as Error;
    expect(e.cause).toBeUndefined();
    expect(e.message).not.toContain(canario);
    expect(String(e.stack)).not.toContain(canario);
    expect(inspect(e, { depth: 10 })).not.toContain(canario);
    expect(JSON.stringify(e)).not.toContain(canario);
  });
});
