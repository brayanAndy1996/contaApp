import { z } from "zod";

/** P5: la contraseña se mide en puntos de código (no en unidades UTF-16). */
export const CONTRASENA_MIN_PUNTOS = 12;
export const CONTRASENA_MAX_PUNTOS = 128;

/** Longitud válida de una contraseña nueva: 12..128 puntos de código, sin reglas de composición. */
export function longitudContrasenaValida(contrasena: string): boolean {
  const puntos = [...contrasena].length;
  return puntos >= CONTRASENA_MIN_PUNTOS && puntos <= CONTRASENA_MAX_PUNTOS;
}

const CORREO_MAX = 320;

/** Contraseña nueva (alta, restablecer, cambio): solo la política de longitud. */
export const contrasenaNuevaSchema = z
  .string()
  .refine(longitudContrasenaValida, { message: "longitud_invalida" });

/**
 * Login: la contraseña NO se limita aquí; una de más de 128 puntos se resuelve en el servicio
 * con el mismo 401 genérico (no con un 400 que la distinga).
 */
export const loginSchema = z.object({
  correo: z.string().max(CORREO_MAX),
  contrasena: z.string(),
});

export const recuperarSchema = z.object({ correo: z.string().max(CORREO_MAX) });

export const restablecerSchema = z.object({
  token: z.string(),
  contrasena: z.string(),
});

export const cambiarContrasenaSchema = z.object({
  actual: z.string(),
  nueva: z.string(),
});

export const cambiarEstudioSchema = z.object({ tenantId: z.uuid() });

export type LoginEntrada = z.infer<typeof loginSchema>;
export type RecuperarEntrada = z.infer<typeof recuperarSchema>;
export type RestablecerEntrada = z.infer<typeof restablecerSchema>;
export type CambiarContrasenaEntrada = z.infer<typeof cambiarContrasenaSchema>;
export type CambiarEstudioEntrada = z.infer<typeof cambiarEstudioSchema>;
