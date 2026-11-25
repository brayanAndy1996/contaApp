// Spec 028 (D-1): el puerto vive en `@contapp/correo`; este archivo lo reexporta para el backend.
export {
  CorreoNoEnviadoError,
  type Correo,
  type MensajeCorreo,
} from "@contapp/correo";
