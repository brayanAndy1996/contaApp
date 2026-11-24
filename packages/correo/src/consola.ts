// STUB (spec 028 T2, rojo).
import type { Correo, MensajeCorreo } from "./puerto.js";

export class CorreoConsola implements Correo {
  enviar(_m: MensajeCorreo): Promise<void> {
    throw new Error("no implementado: CorreoConsola.enviar");
  }
}
