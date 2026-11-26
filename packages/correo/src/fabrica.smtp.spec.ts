import { describe, expect, it } from "vitest";
import { crearCorreo } from "./fabrica.js";
import { CorreoConfigInvalidaError } from "./puerto.js";
import { CorreoSmtp } from "./smtp.js";

// 028 (D-1): el error de configuración es propio del paquete (`CorreoConfigInvalidaError`, con `variable`); el backend lo traduce a EntornoInvalidoError.
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
    ).toThrow(CorreoConfigInvalidaError);
    expect(() =>
      crearCorreo({ provider: "smtp", remitente: "a@x.pe" }),
    ).toThrow(CorreoConfigInvalidaError);
  });
});
