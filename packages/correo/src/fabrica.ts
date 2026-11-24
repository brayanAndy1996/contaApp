// STUB (spec 028 T2, rojo).
import type { Correo } from "./puerto.js";
import type { TransporteCorreo } from "./smtp.js";

export interface ConfigCorreo {
  provider: "consola" | "smtp";
  remitente?: string | undefined;
  smtpUrl?: string | undefined;
}

export function crearCorreo(_config: ConfigCorreo, _transporte?: TransporteCorreo): Correo {
  throw new Error("no implementado: crearCorreo");
}
