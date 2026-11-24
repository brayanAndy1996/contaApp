import { describe, expect, it, vi } from "vitest";
import { crearCorreo } from "./fabrica.js";
import { CorreoConfigInvalidaError } from "./puerto.js";
import { CorreoSmtp } from "./smtp.js";
import * as paquete from "./index.js";

// Spec 028 · T2 (rojo). Fábrica con configuración plana y superficie del paquete (D-1; plan 028, Contratos: correo).
// Contrato fijado por estas pruebas:
//  - `crearCorreo({provider, remitente?, smtpUrl?}, transporte?)` no importa nada del backend: una configuración smtp incompleta lanza
//    `CorreoConfigInvalidaError` con `variable` = "CORREO_REMITENTE" (falta remitente) o "SMTP_URL" (falta smtpUrl y no hay transporte).
//    Su mensaje no incluye el valor de `smtpUrl` ni el remitente (pueden llevar secretos).
//  - `src/index.ts` exporta: CorreoConsola, CorreoMemoria, CorreoSmtp, crearCorreo, CorreoNoEnviadoError, CorreoConfigInvalidaError.
describe("crearCorreo 028: errores de configuración", () => {
  it("sin remitente -> variable CORREO_REMITENTE", () => {
    const f = () => crearCorreo({ provider: "smtp", smtpUrl: "smtp://usuario:CANARIO-CLAVE-12@h:587" });
    expect(f).toThrow(CorreoConfigInvalidaError);
    try {
      f();
    } catch (e) {
      expect((e as CorreoConfigInvalidaError).variable).toBe("CORREO_REMITENTE");
      expect((e as Error).message).not.toContain("CANARIO-CLAVE-12");
    }
  });

  it("sin smtpUrl ni transporte -> variable SMTP_URL", () => {
    try {
      crearCorreo({ provider: "smtp", remitente: "no-responder@estudio.pe" });
      expect.unreachable("debía lanzar");
    } catch (e) {
      expect(e).toBeInstanceOf(CorreoConfigInvalidaError);
      expect((e as CorreoConfigInvalidaError).variable).toBe("SMTP_URL");
    }
  });

  it("con transporte inyectado no exige smtpUrl", () => {
    const correo = crearCorreo({ provider: "smtp", remitente: "no-responder@estudio.pe" }, { sendMail: vi.fn(async () => ({})) });
    expect(correo).toBeInstanceOf(CorreoSmtp);
  });

  it("la fábrica entrega un correo que respeta html y baja del contrato ampliado", async () => {
    const sendMail = vi.fn(async (_m: Record<string, unknown>) => ({}));
    const correo = crearCorreo({ provider: "smtp", remitente: "no-responder@estudio.pe", smtpUrl: "smtp://h:587" }, { sendMail });
    await correo.enviar({ para: "a@x.pe", asunto: "s", texto: "t", html: "<p>x</p>", baja: { url: "https://app.contapp.pe/baja?t=abc" } });
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ html: "<p>x</p>", headers: { "List-Unsubscribe": "<https://app.contapp.pe/baja?t=abc>" } });
  });
});

describe("superficie de @contapp/correo", () => {
  it.each(["CorreoConsola", "CorreoMemoria", "CorreoSmtp", "crearCorreo", "CorreoNoEnviadoError", "CorreoConfigInvalidaError"])("exporta %s", (nombre) => {
    expect((paquete as Record<string, unknown>)[nombre]).toBeDefined();
  });
});
