import { z } from "zod";
import type { Permiso, Rol } from "../acceso/index.js";

// Spec 029 (plan: Contratos: Shared). Esquemas y regla de exigencia del segundo factor.

/** Código TOTP: exactamente 6 dígitos ASCII. */
export const codigoTotpSchema = z.string().regex(/^[0-9]{6}$/);

/** Código de recuperación: 60 bits en base32 (A-Z, 2-7), `XXXX-XXXX-XXXX`. */
export const codigoRecuperacionSchema = z
  .string()
  .regex(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);

export const enrolarTotpSchema = z.object({ contrasena: z.string() });
export const confirmarTotpSchema = z.object({ codigo: codigoTotpSchema });
export const desactivarTotpSchema = z.object({
  contrasena: z.string(),
  codigo: codigoTotpSchema,
});
export const regenerarRecuperacionSchema = z.object({
  contrasena: z.string(),
  codigo: codigoTotpSchema,
});

/** Verificación del segundo factor: exactamente uno de los dos campos, sin claves extra. */
export const verificarSegundoFactorSchema = z.union([
  z.strictObject({ codigo: codigoTotpSchema }),
  z.strictObject({ codigoRecuperacion: codigoRecuperacionSchema }),
]);

export const enrolarTotpRespuestaSchema = z.strictObject({
  uri: z.string().startsWith("otpauth://totp/"),
});

export const CODIGOS_RECUPERACION_CANTIDAD = 10;
export const codigosRecuperacionRespuestaSchema = z.strictObject({
  codigosRecuperacion: z
    .array(codigoRecuperacionSchema)
    .length(CODIGOS_RECUPERACION_CANTIDAD),
});

export const FACTORES_SESION = ["pendiente", "verificado", "sin_factor"] as const;
export type FactorSesion = (typeof FACTORES_SESION)[number];

/** Se suma a la respuesta de `GET /auth/sesion`. */
export const estadoFactorSchema = z.object({
  factor: z.enum(FACTORES_SESION),
  totpActivo: z.boolean(),
  factorExigido: z.boolean(),
});

export const loginSegundoFactorRespuestaSchema = z.strictObject({
  segundoFactor: z.literal(true),
  estudioActivo: z.null(),
});

/** Sesión de la cuenta tal como se lista: sin hash ni token. */
export const sesionCuentaSchema = z.strictObject({
  id: z.uuid(),
  creadaEn: z.iso.datetime({ offset: true }),
  ultimoUso: z.iso.datetime({ offset: true }),
  dispositivo: z.string().max(60),
  ip: z.string().nullable(),
  actual: z.boolean(),
});
export const sesionesCuentaRespuestaSchema = z.array(sesionCuentaSchema);

export const CODIGOS_ERROR_SEGURIDAD = [
  "codigo_invalido",
  "segundo_factor_requerido",
  "totp_exigido",
] as const;
export type CodigoErrorSeguridad = (typeof CODIGOS_ERROR_SEGURIDAD)[number];
export const errorSeguridadSchema = z.strictObject({
  codigo: z.enum(CODIGOS_ERROR_SEGURIDAD),
});

export type CodigoTotp = z.infer<typeof codigoTotpSchema>;
export type EnrolarTotpEntrada = z.infer<typeof enrolarTotpSchema>;
export type ConfirmarTotpEntrada = z.infer<typeof confirmarTotpSchema>;
export type DesactivarTotpEntrada = z.infer<typeof desactivarTotpSchema>;
export type RegenerarRecuperacionEntrada = z.infer<
  typeof regenerarRecuperacionSchema
>;
export type VerificarSegundoFactorEntrada = z.infer<
  typeof verificarSegundoFactorSchema
>;
export type EstadoFactor = z.infer<typeof estadoFactorSchema>;
export type SesionCuenta = z.infer<typeof sesionCuentaSchema>;

/** Roles de sistema que siempre exigen el segundo factor (U1). */
const ROLES_EXIGEN: readonly Rol[] = ["dueno", "admin"];
/** Permisos que exigen el segundo factor en un rol propio del estudio (U2). */
const PERMISOS_EXIGEN: readonly Permiso[] = [
  "usuarios.gestionar",
  "roles.gestionar",
  "plan.gestionar",
  "credenciales.editar",
];

/**
 * ¿Se exige TOTP verificado? (U1–U2). Super-admin, Dueño y Administrador siempre; en un rol propio
 * (`rolSistema` null) basta alguno de los cuatro permisos sensibles; los demás roles de sistema, no.
 */
export function factorExigido(o: {
  plataforma: boolean;
  rolSistema: Rol | null;
  permisos: readonly Permiso[];
}): boolean {
  if (o.plataforma) return true;
  if (o.rolSistema !== null) return ROLES_EXIGEN.includes(o.rolSistema);
  return o.permisos.some((p) => PERMISOS_EXIGEN.includes(p));
}
