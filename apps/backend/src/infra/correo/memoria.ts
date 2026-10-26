import type { Correo, MensajeCorreo } from "./correo.js";

/** Doble de pruebas: solo se inyecta por `crearApp({ correo })`, nunca por entorno. */
export class CorreoMemoria implements Correo {
  readonly enviados: MensajeCorreo[] = [];

  async enviar(m: MensajeCorreo): Promise<void> {
    this.enviados.push(m);
  }
}
