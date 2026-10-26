import { createTransport } from "nodemailer";
import { EntornoInvalidoError, type Entorno } from "../../config/entorno.js";
import { CorreoConsola } from "./consola.js";
import type { Correo } from "./correo.js";
import { CorreoSmtp, type TransporteCorreo } from "./smtp.js";

/** `consola` en desarrollo; `smtp` con nodemailer (sin conectar al construirse) o un transporte inyectado. */
export function crearCorreo(
  config: Entorno["correo"],
  transporte?: TransporteCorreo,
): Correo {
  if (config.provider === "consola") return new CorreoConsola();
  if (config.remitente === undefined)
    throw new EntornoInvalidoError("CORREO_REMITENTE");
  if (transporte !== undefined)
    return new CorreoSmtp({ remitente: config.remitente, transporte });
  if (config.smtpUrl === undefined) throw new EntornoInvalidoError("SMTP_URL");
  return new CorreoSmtp({
    remitente: config.remitente,
    transporte: createTransport(config.smtpUrl),
  });
}
