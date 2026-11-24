import { z } from "zod";

// Spec 028 (plan, Contratos: shared; R-7, R-10, R-15; D-4). Cuerpos de las solicitudes de correo. Todos `.strict()`:
// el usuario y el estudio salen de la sesión, nunca del cuerpo.

/** Los cuatro tipos de correo, en este orden. */
export const TIPOS_CORREO = [
  "buzon_critico",
  "credencial_invalida",
  "plan_limite",
  "resumen",
] as const;
export type TipoCorreo = (typeof TIPOS_CORREO)[number];
export const tipoCorreoSchema = z.enum(TIPOS_CORREO);

/** PUT /cuenta/correo: las cinco preferencias, todas obligatorias y booleanas estrictas. */
export const preferenciasCorreoSchema = z
  .object({
    buzonCritico: z.boolean(),
    credencialInvalida: z.boolean(),
    planLimite: z.boolean(),
    resumen: z.boolean(),
    todosClientes: z.boolean(),
  })
  .strict();
export type PreferenciasCorreo = z.infer<typeof preferenciasCorreoSchema>;

/** POST /correo/baja: token base64url de 43 caracteres (32 bytes sin relleno). */
export const bajaSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export type Baja = z.infer<typeof bajaSchema>;
