import {
  CorreoConfigInvalidaError,
  crearCorreo as crearCorreoBase,
  type Correo,
  type TransporteCorreo,
} from "@contapp/correo";
import { EntornoInvalidoError, type Entorno } from "../../config/entorno.js";

/**
 * `consola` en desarrollo; `smtp` con nodemailer (sin conectar al construirse) o un transporte inyectado.
 * Spec 028 (D-1): la fábrica vive en `@contapp/correo`; aquí solo se traduce su error de configuración al del entorno.
 */
export function crearCorreo(
  config: Entorno["correo"],
  transporte?: TransporteCorreo,
): Correo {
  try {
    return crearCorreoBase(config, transporte);
  } catch (e) {
    if (e instanceof CorreoConfigInvalidaError)
      throw new EntornoInvalidoError(e.variable);
    throw e;
  }
}
