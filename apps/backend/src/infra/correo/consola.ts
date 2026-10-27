import type { Correo, MensajeCorreo } from "./correo.js";

/**
 * Desarrollo: imprime el mensaje completo en stdout, FUERA del logger. Es la única excepción de
 * CA-10 (permite ver el enlace de recuperación); el entorno la prohíbe en producción.
 */
export class CorreoConsola implements Correo {
  async enviar(m: MensajeCorreo): Promise<void> {
    process.stdout.write(
      `\n[correo:consola]\npara: ${m.para}\nasunto: ${m.asunto}\n\n${m.texto}\n\n`,
    );
  }
}
