import type { Correo, MensajeCorreo } from "./puerto.js";

/** Doble de pruebas: guarda el mensaje completo (con `html`, `baja` e `idMensaje`). Solo se inyecta, nunca por entorno. */
export class CorreoMemoria implements Correo {
  readonly enviados: MensajeCorreo[] = [];

  async enviar(m: MensajeCorreo): Promise<void> {
    this.enviados.push(m);
  }
}
