import type { MensajeCorreo } from "../../infra/correo/correo.js";

/**
 * D3: enlace de confirmación con el token en el fragmento (no viaja al servidor en el GET). El texto es el
 * mismo exista o no una cuenta con ese correo (no enumera) y no lleva el nombre del estudio ni del titular.
 */
export function mensajeRegistro(
  para: string,
  appOrigin: string,
  token: string,
): MensajeCorreo {
  return {
    para,
    asunto: "ContApp: confirma tu registro",
    texto:
      "Recibimos una solicitud para crear un estudio en ContApp. Para confirmarla entra a este enlace " +
      "(vence en 24 horas y sirve una sola vez):\n\n" +
      `${appOrigin}/registro/confirmar#t=${token}\n\n` +
      "Si no lo pediste, ignora este correo: no se crea nada.",
  };
}
