import type { Correo, MensajeCorreo } from "./puerto.js";

/** Valor de `t` de la URL de baja; `null` si la URL no es válida o no lo lleva. */
const tokenDe = (url: string): string | null => {
  try {
    const t = new URL(url).searchParams.get("t");
    return t === null || t === "" ? null : t;
  } catch {
    return null;
  }
};

/**
 * Desarrollo: imprime el mensaje en stdout, FUERA del logger. Es la única excepción de CA-10 (permite ver el enlace de
 * recuperación); el entorno la prohíbe en producción. Spec 028: del HTML solo la marca `[html]`; la URL de baja se sustituye
 * por `[baja]` en todo el mensaje y, además (D-T24-1), toda palabra que lleve su token (p. ej. el enlace `/baja?t=` de la
 * página, que es otra URL con el mismo token) también se sustituye entera por `[baja]`.
 */
export class CorreoConsola implements Correo {
  async enviar(m: MensajeCorreo): Promise<void> {
    const url = m.baja?.url ?? "";
    const token = tokenDe(url);
    const ocultar = (s: string): string => {
      const sinUrl = url === "" ? s : s.split(url).join("[baja]");
      return token === null
        ? sinUrl
        : sinUrl
            .split(/(\s+)/)
            .map((p) => (p.includes(token) ? "[baja]" : p))
            .join("");
    };
    const marcas =
      (m.html === undefined ? "" : "[html]\n") +
      (m.baja === undefined ? "" : "[baja]\n");
    process.stdout.write(
      `\n[correo:consola]\npara: ${ocultar(m.para)}\nasunto: ${ocultar(m.asunto)}\n${marcas}\n${ocultar(m.texto)}\n\n`,
    );
  }
}
