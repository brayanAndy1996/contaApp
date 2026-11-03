// Textos y forma de respuesta del registro público de un estudio (spec 006, D3, CA-3, CA-4). Son los
// que muestran /registro y /registro/confirmar. Nunca se repite el correo ni el detalle que devuelve el
// servidor: el mensaje es el mismo exista o no una cuenta.

export const MENSAJES_REGISTRO = {
  revisaCorreo: "Revisa tu correo para continuar con el registro.",
  enlaceVence: "El enlace vence en 24 horas.",
  rucInvalido: "El RUC debe tener 11 dígitos.",
  solicitudInvalida: "Revisa los datos ingresados.",
  demasiadosIntentos:
    "Demasiados intentos. Inténtalo de nuevo en unos minutos.",
  registroInvalido:
    "El enlace no es válido o venció. Solicita un registro nuevo.",
  registroNoDisponible:
    "El registro no está disponible por ahora. Inténtalo más tarde.",
  registroCreado: "Tu estudio fue creado. Ya puedes iniciar sesión.",
  estudioCreado: (estudio: string) => `Tu estudio ${estudio} fue creado.`,
  contrasenaLongitud: "La contraseña debe tener entre 12 y 128 caracteres.",
  contrasenaComun: "Esa contraseña es demasiado común. Elige otra.",
  credencialesInvalidas: "Correo o contraseña incorrectos.",
} as const;

/** Cuerpo de `POST /registro/consultar` (el token no vuelve en la respuesta). */
export interface ConsultaRegistro {
  estudio: { nombre: string };
  correo: string;
  cuentaExiste: boolean;
}
