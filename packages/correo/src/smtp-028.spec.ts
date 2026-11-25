import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorreoSmtp } from "./smtp.js";
import { CorreoNoEnviadoError } from "./puerto.js";

// Spec 028 · T2 (rojo). `CorreoSmtp` ampliado (R-1, R-6, R-7, R-9; D-1; plan 028, Contratos: correo; CA-7, CA-8, CA-10).
// Contrato fijado por estas pruebas (packages/correo/src/smtp.ts):
//  - Sin `html`, `baja` ni `idMensaje` el transporte recibe EXACTAMENTE {from, to, subject, text} (las claves opcionales no viajan, ni como undefined).
//  - Con `html` el transporte recibe además `html` (nodemailer arma el multiparte alternativo texto + HTML).
//  - Con `baja: {url}` recibe `headers` con SOLO estas dos entradas (RFC 8058; no hay cabeceras libres):
//      "List-Unsubscribe": "<url>"  y  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click".
//  - Con `idMensaje` recibe `messageId: "<idMensaje@dominio>"` donde dominio = el del remitente (`a@estudio.pe` y `Nombre <a@estudio.pe>` -> estudio.pe).
//    Un `idMensaje` con espacios, controles, `<`, `>` o `@` se rechaza (el id lo pone el worker: es el uuid del envío).
//  - Entradas que se rechazan ANTES de tocar el transporte, con `CorreoNoEnviadoError` sin `cause` y sin copiar la entrada en mensaje ni traza:
//    `para` o `asunto` con CR, LF o cualquier carácter de control; `baja.url` que no sea `https:` (se acepta `http://localhost…` solo con NODE_ENV distinto de
//    production), con controles, espacios o `<`/`>`.
//  - Un fallo del transporte sigue sin `cause` ni texto del error original.
const REMITENTE = "no-responder@estudio.pe";
const BASE = { para: "ana@estudio.pe", asunto: "Aviso", texto: "Cuerpo" };
const ID = "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c10";
const URL_BAJA = "https://app.contapp.pe/baja?t=CANARIO-TOKEN-BAJA-0123456789abcdefghijklmnopq";

const crear = () => {
  const sendMail = vi.fn<(m: Record<string, unknown>) => Promise<unknown>>(async () => ({ messageId: "m1" }));
  const correo = new CorreoSmtp({ remitente: REMITENTE, transporte: { sendMail } });
  return { correo, sendMail };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CorreoSmtp 028: forma del mensaje al transporte", () => {
  it("sin opcionales, el transporte recibe solo from, to, subject y text", async () => {
    const { correo, sendMail } = crear();
    await correo.enviar(BASE);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(Object.keys(sendMail.mock.calls[0]![0]).sort()).toEqual(["from", "subject", "text", "to"]);
  });

  it("con html agrega html y conserva el texto (multiparte)", async () => {
    const { correo, sendMail } = crear();
    await correo.enviar({ ...BASE, html: "<table><tr><td>Hola</td></tr></table>" });
    expect(sendMail.mock.calls[0]![0]).toEqual({
      from: REMITENTE,
      to: "ana@estudio.pe",
      subject: "Aviso",
      text: "Cuerpo",
      html: "<table><tr><td>Hola</td></tr></table>",
    });
  });

  it("con baja arma las dos cabeceras de RFC 8058 y ninguna otra", async () => {
    const { correo, sendMail } = crear();
    await correo.enviar({ ...BASE, baja: { url: URL_BAJA } });
    const enviado = sendMail.mock.calls[0]![0];
    expect(enviado.headers).toEqual({
      "List-Unsubscribe": `<${URL_BAJA}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(Object.keys(enviado).sort()).toEqual(["from", "headers", "subject", "text", "to"]);
  });

  it("sin baja no hay cabeceras", async () => {
    const { correo, sendMail } = crear();
    await correo.enviar({ ...BASE, html: "<p>x</p>", idMensaje: ID });
    expect(sendMail.mock.calls[0]![0]).not.toHaveProperty("headers");
  });

  it("idMensaje -> messageId <id@dominio-del-remitente>", async () => {
    const { correo, sendMail } = crear();
    await correo.enviar({ ...BASE, idMensaje: ID });
    expect(sendMail.mock.calls[0]![0].messageId).toBe(`<${ID}@estudio.pe>`);
  });

  it("el dominio sale del remitente aunque lleve nombre: «Estudio <a@estudio.pe>»", async () => {
    const sendMail = vi.fn(async () => ({}));
    const correo = new CorreoSmtp({ remitente: "ContApp <avisos@mail.estudio.pe>", transporte: { sendMail } });
    await correo.enviar({ ...BASE, idMensaje: ID });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ messageId: `<${ID}@mail.estudio.pe>`, from: "ContApp <avisos@mail.estudio.pe>" }));
  });

  it("el mismo idMensaje da el mismo Message-ID en dos envíos (reintento al menos una vez, R-9)", async () => {
    const { correo, sendMail } = crear();
    await correo.enviar({ ...BASE, idMensaje: ID });
    await correo.enviar({ ...BASE, idMensaje: ID });
    expect(sendMail.mock.calls[0]![0].messageId).toBe(sendMail.mock.calls[1]![0].messageId);
  });

  it("html, baja e idMensaje juntos viajan completos", async () => {
    const { correo, sendMail } = crear();
    await correo.enviar({ ...BASE, html: "<p>x</p>", baja: { url: URL_BAJA }, idMensaje: ID });
    expect(sendMail.mock.calls[0]![0]).toEqual({
      from: REMITENTE,
      to: "ana@estudio.pe",
      subject: "Aviso",
      text: "Cuerpo",
      html: "<p>x</p>",
      messageId: `<${ID}@estudio.pe>`,
      headers: { "List-Unsubscribe": `<${URL_BAJA}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
  });

  it("acepta una baja http://localhost fuera de producción y la rechaza en producción", async () => {
    const local = "http://localhost:3000/baja?t=abc";
    vi.stubEnv("NODE_ENV", "development");
    const a = crear();
    await a.correo.enviar({ ...BASE, baja: { url: local } });
    expect(a.sendMail).toHaveBeenCalledTimes(1);
    vi.stubEnv("NODE_ENV", "production");
    const b = crear();
    await expect(b.correo.enviar({ ...BASE, baja: { url: local } })).rejects.toBeInstanceOf(CorreoNoEnviadoError);
    expect(b.sendMail).not.toHaveBeenCalled();
  });
});

describe("CorreoSmtp 028: entradas inseguras se rechazan antes del transporte (CA-7)", () => {
  const CANARIO = "CANARIO-BCC-55";
  const casos: [string, Record<string, unknown>][] = [
    ["para con CRLF y Bcc", { para: `ana@estudio.pe\r\nBcc: ${CANARIO}@x.pe` }],
    ["para con LF", { para: `ana@estudio.pe\nBcc: ${CANARIO}@x.pe` }],
    ["para con CR", { para: `ana@estudio.pe\r${CANARIO}` }],
    ["para con NUL", { para: `ana@estudio.pe\u0000${CANARIO}` }],
    ["para con tabulación", { para: `ana@estudio.pe\t${CANARIO}` }],
    ["asunto con CRLF", { asunto: `Aviso\r\nBcc: ${CANARIO}@x.pe` }],
    ["asunto con LF", { asunto: `Aviso\n${CANARIO}` }],
    ["asunto con CR", { asunto: `Aviso\r${CANARIO}` }],
    ["asunto con NUL", { asunto: `Aviso\u0000${CANARIO}` }],
    ["asunto con ESC", { asunto: `Aviso\u001b[31m${CANARIO}` }],
    ["asunto con DEL", { asunto: `Aviso\u007f${CANARIO}` }],
    ["baja http no local", { baja: { url: `http://app.contapp.pe/baja?t=${CANARIO}` } }],
    ["baja ftp", { baja: { url: `ftp://app.contapp.pe/baja?t=${CANARIO}` } }],
    ["baja javascript", { baja: { url: `javascript:alert('${CANARIO}')` } }],
    ["baja relativa", { baja: { url: `/baja?t=${CANARIO}` } }],
    ["baja vacía", { baja: { url: "" } }],
    ["baja con CRLF", { baja: { url: `https://app.contapp.pe/baja?t=${CANARIO}\r\nBcc: x@y.pe` } }],
    ["baja con espacio", { baja: { url: `https://app.contapp.pe/baja?t=${CANARIO} x` } }],
    ["baja con >", { baja: { url: `https://app.contapp.pe/baja?t=${CANARIO}>, <https://malo.pe` } }],
    ["baja con <", { baja: { url: `https://app.contapp.pe/baja?t=<${CANARIO}` } }],
    ["idMensaje con CRLF", { idMensaje: `${ID}\r\nBcc: ${CANARIO}@x.pe` }],
    ["idMensaje con espacio", { idMensaje: `${ID} ${CANARIO}` }],
    ["idMensaje con @", { idMensaje: `${CANARIO}@malo.pe` }],
    ["idMensaje con <>", { idMensaje: `<${CANARIO}>` }],
  ];

  it.each(casos)("%s -> CorreoNoEnviadoError, el transporte no se toca, sin cause ni el canario en la traza", async (_n, cambio) => {
    const { correo, sendMail } = crear();
    const error = await correo.enviar({ ...BASE, ...cambio } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorreoNoEnviadoError);
    const e = error as Error;
    expect(e.message).toBe("correo_no_enviado");
    expect(e.cause).toBeUndefined();
    expect(String(e.stack)).not.toContain(CANARIO);
    expect(inspect(e, { depth: 10 })).not.toContain(CANARIO);
    expect(JSON.stringify(e)).not.toContain(CANARIO);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("un destinatario y un asunto normales con acentos y símbolos pasan", async () => {
    const { correo, sendMail } = crear();
    await correo.enviar({ ...BASE, asunto: "Coactiva y avisos críticos del buzón · Ñandú S.A.C." });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("un fallo del transporte con baja e html sigue sin cause ni texto original", async () => {
    const canario = "CANARIO-SMTP-URL-91";
    const sendMail = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED smtp://u:${canario}@correo.interno:587`);
    });
    const correo = new CorreoSmtp({ remitente: REMITENTE, transporte: { sendMail } });
    const error = await correo.enviar({ ...BASE, html: "<p>x</p>", baja: { url: URL_BAJA }, idMensaje: ID }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorreoNoEnviadoError);
    expect((error as Error).cause).toBeUndefined();
    expect(inspect(error, { depth: 10 })).not.toContain(canario);
    expect(inspect(error, { depth: 10 })).not.toContain("CANARIO-TOKEN-BAJA");
  });
});
