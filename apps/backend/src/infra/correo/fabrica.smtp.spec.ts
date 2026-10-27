import { describe, expect, it } from "vitest";
import { EntornoInvalidoError } from "../../config/entorno.js";
import { crearCorreo } from "./fabrica.js";
import { CorreoSmtp } from "./smtp.js";

// Ramas de crearCorreo que fabrica.spec.ts no ejercita: nodemailer real (sin conectar) y
// configuración smtp incompleta.
describe("crearCorreo smtp sin transporte inyectado", () => {
  it("crea nodemailer desde smtpUrl sin conectar al construirse", () => {
    const correo = crearCorreo({
      provider: "smtp",
      remitente: "no-responder@estudio.pe",
      smtpUrl: "smtp://usuario:clave@127.0.0.1:1",
    });
    expect(correo).toBeInstanceOf(CorreoSmtp);
  });

  it("sin remitente o sin smtpUrl impide crearlo", () => {
    expect(() =>
      crearCorreo({ provider: "smtp", smtpUrl: "smtp://h:587" }),
    ).toThrow(EntornoInvalidoError);
    expect(() =>
      crearCorreo({ provider: "smtp", remitente: "a@x.pe" }),
    ).toThrow(EntornoInvalidoError);
  });
});
