import { CorreoConsola, CorreoSmtp } from "@contapp/correo";
import { describe, expect, it, vi } from "vitest";
import { EntornoInvalidoError } from "../../config/entorno.js";
import { crearCorreo } from "./fabrica.js";

// Spec 028 (D-1): la fábrica vive en @contapp/correo; el backend solo traduce su error de configuración al del entorno.
describe("crearCorreo del backend", () => {
  it("consola y smtp con transporte entregan las clases del paquete", () => {
    expect(crearCorreo({ provider: "consola" })).toBeInstanceOf(CorreoConsola);
    const smtp = crearCorreo(
      { provider: "smtp", remitente: "no-responder@estudio.pe" },
      { sendMail: vi.fn(async () => ({})) },
    );
    expect(smtp).toBeInstanceOf(CorreoSmtp);
  });

  it("traduce la configuración incompleta a EntornoInvalidoError con la variable", () => {
    const sinRemitente = () => crearCorreo({ provider: "smtp", smtpUrl: "smtp://h:587" });
    expect(sinRemitente).toThrow(EntornoInvalidoError);
    expect(() => crearCorreo({ provider: "smtp", remitente: "a@x.pe" })).toThrow(
      expect.objectContaining({ variable: "SMTP_URL" }),
    );
  });
});
