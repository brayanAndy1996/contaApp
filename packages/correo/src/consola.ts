import type { Correo, MensajeCorreo } from "./puerto.js";

/**
 * Desarrollo: imprime el mensaje en stdout, FUERA del logger. Es la única excepción de CA-10 (permite ver el enlace de
 * recuperación); el entorno la prohíbe en producción. Spec 028: del HTML solo la marca `[html]`, y la URL de baja (lleva el
 * token) se sustituye por `[baja]` en todo el mensaje.
 */
export class CorreoConsola implements Correo {
  async enviar(m: MensajeCorreo): Promise<void> {
    const ocultar = (s: string): string =>
      m.baja === undefined || m.baja.url === ""
        ? s
        : s.split(m.baja.url).join("[baja]");
    const marcas =
      (m.html === undefined ? "" : "[html]\n") +
      (m.baja === undefined ? "" : "[baja]\n");
    process.stdout.write(
      `\n[correo:consola]\npara: ${ocultar(m.para)}\nasunto: ${ocultar(m.asunto)}\n${marcas}\n${ocultar(m.texto)}\n\n`,
    );
  }
}
