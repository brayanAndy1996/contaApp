import { createTransport } from "nodemailer";
import { CorreoConsola } from "./consola.js";
import { CorreoConfigInvalidaError, type Correo } from "./puerto.js";
import { CorreoSmtp, type TransporteCorreo } from "./smtp.js";

/** Configuración plana: no depende del entorno de ninguna app. */
export interface ConfigCorreo {
  provider: "consola" | "smtp";
  remitente?: string | undefined;
  smtpUrl?: string | undefined;
}

/**
 * `consola` en desarrollo; `smtp` con nodemailer (sin conectar al construirse) o un transporte inyectado.
 * Una configuración smtp incompleta lanza `CorreoConfigInvalidaError` con la variable que falta.
 */
export function crearCorreo(
  config: ConfigCorreo,
  transporte?: TransporteCorreo,
): Correo {
  if (config.provider === "consola") return new CorreoConsola();
  if (config.remitente === undefined)
    throw new CorreoConfigInvalidaError("CORREO_REMITENTE");
  if (transporte !== undefined)
    return new CorreoSmtp({ remitente: config.remitente, transporte });
  if (config.smtpUrl === undefined)
    throw new CorreoConfigInvalidaError("SMTP_URL");
  return new CorreoSmtp({
    remitente: config.remitente,
    transporte: createTransport(config.smtpUrl),
  });
}
