import type { MensajeCorreo } from "../../infra/correo/correo.js";

// Textos de los correos de `auth`. Nunca llevan contraseñas ni hashes; el único secreto que viaja
// por correo es el token de recuperación, dentro del enlace (D8).

/** P3: aviso al titular cuando su cuenta se bloquea (como máximo uno cada 24 h, P13: lo decide la BD). */
export function mensajeBloqueo(para: string): MensajeCorreo {
  return {
    para,
    asunto: "ContApp: tu cuenta se bloqueó temporalmente",
    texto:
      "Hubo varios intentos fallidos de iniciar sesión con tu cuenta de ContApp y la bloqueamos " +
      "durante 15 minutos.\n\nSi no fuiste tú, te recomendamos restablecer tu contraseña desde la " +
      "pantalla de inicio de sesión.",
  };
}

/** P9 / P11: aviso al titular cuando su contraseña cambia (restablecida o cambiada con sesión). */
export function mensajeContrasenaCambiada(para: string): MensajeCorreo {
  return {
    para,
    asunto: "ContApp: tu contraseña cambió",
    texto:
      "La contraseña de tu cuenta de ContApp acaba de cambiar y se cerraron tus otras sesiones.\n\n" +
      "Si no fuiste tú, restablece tu contraseña de inmediato y avisa a tu estudio.",
  };
}

/** D8: enlace de recuperación con el token en el fragmento (no viaja al servidor en el GET). */
export function mensajeRecuperacion(para: string, appOrigin: string, token: string): MensajeCorreo {
  return {
    para,
    asunto: "ContApp: restablece tu contraseña",
    texto:
      "Para elegir una contraseña nueva entra a este enlace (vence en 30 minutos y sirve una sola vez):\n\n" +
      `${appOrigin}/recuperar/nueva#t=${token}\n\n` +
      "Si no lo pediste, ignora este correo: tu contraseña no cambia.",
  };
}
