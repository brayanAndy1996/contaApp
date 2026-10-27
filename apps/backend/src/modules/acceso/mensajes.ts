import type { MensajeCorreo } from "../../infra/correo/correo.js";

/**
 * CA-2, D7: enlace con el token en el fragmento (no viaja al servidor en el GET). El texto es el mismo
 * exista o no una cuenta con ese correo (no enumera) y no lleva datos del estudio ni de quien invita.
 */
export function mensajeInvitacion(
  para: string,
  appOrigin: string,
  token: string,
): MensajeCorreo {
  return {
    para,
    asunto: "ContApp: te invitaron a un estudio",
    texto:
      "Te invitaron a unirte a un estudio en ContApp. Para aceptar entra a este enlace " +
      "(vence en 72 horas y sirve una sola vez):\n\n" +
      `${appOrigin}/invitacion#t=${token}\n\n` +
      "Si no esperabas esta invitación, ignora este correo.",
  };
}
