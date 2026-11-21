import { z } from "zod";
import { MOTIVOS_TRABAJO } from "../trabajos/esquemas.js";

// Spec 025 (plan, Contratos: shared; D-4, D-10, D-11; U-5). Importación del historial presentado en el SIRE.

/** Periodos por defecto de una importación (U-5) y tope (12). */
export const PERIODOS_IMPORTACION_POR_DEFECTO = 6;
export const PERIODOS_IMPORTACION_MAX = 12;

const periodoSchema = z.string().regex(/^[0-9]{4}(0[1-9]|1[0-2])$/);
const entero = z.number().int().min(0);

/** POST …/reglas/importaciones: solo cuántos periodos; el backend calcula cuáles (del mes anterior, Lima, hacia atrás). */
export const solicitarImportacionSchema = z
  .object({ periodos: z.number().int().min(1).max(PERIODOS_IMPORTACION_MAX).default(PERIODOS_IMPORTACION_POR_DEFECTO) })
  .strict();
export type SolicitarImportacion = z.infer<typeof solicitarImportacionSchema>;

export const ESTADOS_IMPORTACION = ["en_curso", "completada", "fallida"] as const;
export type EstadoImportacion = (typeof ESTADOS_IMPORTACION)[number];

/** Vista de la importación: solo conteos y periodos (D-11); `z.object` descarta cualquier otra clave. */
export const importacionVistaSchema = z.object({
  id: z.uuid(),
  estado: z.enum(ESTADOS_IMPORTACION),
  periodos: z.array(periodoSchema).min(1).max(PERIODOS_IMPORTACION_MAX),
  solicitadaPor: z.object({ id: z.uuid(), nombre: z.string().nullable(), activo: z.boolean().optional() }),
  solicitadaEn: z.iso.datetime(),
  terminadaEn: z.iso.datetime().nullable(),
  resumen: z
    .object({
      periodosLeidos: entero,
      periodosSinDatos: z.array(periodoSchema),
      candidatas: entero,
      sinCriterio: entero,
    })
    .nullable(),
  motivo: z.enum(MOTIVOS_TRABAJO).nullable(),
  trabajoId: z.uuid().nullable(),
});
export type ImportacionVista = z.infer<typeof importacionVistaSchema>;
