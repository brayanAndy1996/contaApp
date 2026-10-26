import { Logger } from "@nestjs/common";
import type { Correo, MensajeCorreo } from "./correo.js";

const CODIGO_FALLO = "correo_no_enviado";
const logger = new Logger("ColaCorreo");

/**
 * D8: el envío sale con `setImmediate`, fuera de la petición y de cualquier `withTenant`; quien
 * encola no espera ni ve errores. Solo se registra un código fijo: jamás el error ni el mensaje.
 */
export class ColaCorreo {
  private readonly correo: Correo;
  private readonly registrar: (codigo: string) => void;

  constructor(
    correo: Correo,
    registrar: (codigo: string) => void = (c) => logger.warn(c),
  ) {
    this.correo = correo;
    this.registrar = registrar;
  }

  encolar(m: MensajeCorreo): void {
    setImmediate(() => {
      void this.enviar(m);
    });
  }

  private async enviar(m: MensajeCorreo): Promise<void> {
    try {
      await this.correo.enviar(m);
    } catch {
      this.registrar(CODIGO_FALLO);
    }
  }
}
