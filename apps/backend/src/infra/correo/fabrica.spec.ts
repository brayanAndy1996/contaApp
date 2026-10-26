import { describe, expect, it, vi } from "vitest";
import { CorreoConsola } from "./consola.js";
import { crearCorreo } from "./fabrica.js";
import { CorreoSmtp } from "./smtp.js";

// D11 (spec 004). Contrato: crearCorreo(config: Entorno["correo"], transporte?): Correo
//   - provider "consola" -> CorreoConsola;
//   - provider "smtp"    -> CorreoSmtp (con `transporte` inyectado si se pasa; si no, nodemailer
//                           creado desde config.smtpUrl, sin conectar al construirse).
describe("crearCorreo", () => {
  it("consola -> CorreoConsola", () => {
    expect(crearCorreo({ provider: "consola" })).toBeInstanceOf(CorreoConsola);
  });

  it("smtp con transporte inyectado -> CorreoSmtp que usa ese transporte", async () => {
    const sendMail = vi.fn(async () => ({}));
    const correo = crearCorreo(
      { provider: "smtp", remitente: "no-responder@estudio.pe", smtpUrl: "smtp://h:587" },
      { sendMail },
    );
    expect(correo).toBeInstanceOf(CorreoSmtp);
    await correo.enviar({ para: "a@x.pe", asunto: "s", texto: "t" });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
