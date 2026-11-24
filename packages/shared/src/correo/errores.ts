import { z } from "zod";

// Spec 028 (plan, Contratos: shared; HTTP). Código nuevo: `todos_clientes_no_disponible` (409). Se reutilizan `solicitud_invalida`,
// `permiso_denegado` y `demasiados_intentos`. El cuerpo es solo `{codigo}`.
export const CODIGOS_ERROR_CORREO = ["todos_clientes_no_disponible"] as const;
export type CodigoErrorCorreo = (typeof CODIGOS_ERROR_CORREO)[number];
export const errorCorreoSchema = z
  .object({ codigo: z.enum(CODIGOS_ERROR_CORREO) })
  .strict();
export type ErrorCorreo = z.infer<typeof errorCorreoSchema>;
