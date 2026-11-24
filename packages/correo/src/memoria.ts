// STUB (spec 028 T2, rojo).
import type { Correo, MensajeCorreo } from "./puerto.js";

export class CorreoMemoria implements Correo {
  readonly enviados: MensajeCorreo[] = [];

  enviar(_m: MensajeCorreo): Promise<void> {
    throw new Error("no implementado: CorreoMemoria.enviar");
  }
}
