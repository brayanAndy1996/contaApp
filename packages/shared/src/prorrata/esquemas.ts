import { z } from "zod";

// Spec 026 (plan, Contratos: shared; D-3, D-5; U-4, U-9). Cuerpos de las solicitudes de prorrata.
// Montos y porcentajes viajan como CADENAS decimales: nunca `number`.

/** AAAAMM con mes 01-12 (ASCII: sin dígitos de ancho completo). */
export const PERIODO_PRORRATA_RE = /^[0-9]{4}(0[1-9]|1[0-2])$/;
export const periodoProrrataSchema = z.string().regex(PERIODO_PRORRATA_RE);

/** Cadena decimal con signo y hasta 2 decimales, dentro de NUMERIC(14,2): 12 enteros + 2 decimales. */
export const MONTO_PRORRATA_RE = /^-?[0-9]{1,12}(\.[0-9]{1,2})?$/;
export const montoProrrataSchema = z.string().regex(MONTO_PRORRATA_RE);

/** Porcentaje 0..100 con a lo sumo 2 decimales (gramática del dominio, U-9). */
export const PORCENTAJE_USADA_RE = /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/;

/** Porcentaje de las vistas: siempre «NN.NN» (0.00 a 100.00). */
export const PORCENTAJE_VISTA_RE = /^(100\.00|[0-9]{1,2}\.[0-9]{2})$/;

export const LARGO_MAX_MOTIVO_PRORRATA = 500;

const CONTROLES = /\p{Cc}/u;
const BIDI = /[‪-‮⁦-⁩‎‏؜]/;

/** Texto plano de 1..500 sin controles ni bidi. Se escapa al pintar, no aquí. */
export const motivoProrrataSchema = z
  .string()
  .trim()
  .min(1)
  .max(LARGO_MAX_MOTIVO_PRORRATA)
  .refine((t) => !CONTROLES.test(t) && !BIDI.test(t), { message: "motivo con caracteres no permitidos" });

const version = z.number().int().min(0);

/** POST …/prorrata/declaraciones: el cliente sale de la ruta y la ventana, del periodo. */
export const obtenerDeclaracionesSchema = z.object({ periodo: periodoProrrataSchema }).strict();
export type ObtenerDeclaraciones = z.infer<typeof obtenerDeclaracionesSchema>;

/** PUT …/prorrata/meses/:periodo. `version` = última versión del mes (0 si nunca tuvo manual; «eliminado» también cuenta). */
export const guardarMesManualSchema = z
  .object({
    gravadas: montoProrrataSchema,
    exportaciones: montoProrrataSchema,
    noGravadas: montoProrrataSchema,
    motivo: motivoProrrataSchema,
    version,
  })
  .strict();
export type GuardarMesManual = z.infer<typeof guardarMesManualSchema>;

/** POST …/prorrata/meses/:periodo/eliminar: no hay nada que eliminar en la versión 0. */
export const eliminarMesManualSchema = z
  .object({ motivo: motivoProrrataSchema, version: z.number().int().min(1) })
  .strict();
export type EliminarMesManual = z.infer<typeof eliminarMesManualSchema>;

/** PUT …/prorrata/usada/:periodo. `porcentaje: null` quita la prorrata ingresada. */
export const guardarProrrataUsadaSchema = z
  .object({ porcentaje: z.string().regex(PORCENTAJE_USADA_RE).nullable(), version })
  .strict();
export type GuardarProrrataUsada = z.infer<typeof guardarProrrataUsadaSchema>;
