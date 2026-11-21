import { z } from "zod";
import { destinoCompraSchema } from "../compras/esquemas.js";
import { versionReglaSchema } from "./esquemas.js";

// Spec 025 (plan, Contratos: shared; D-4 a D-6, D-10, D-11; U-2, U-8). Candidatas deducidas del historial.

/** Tope de ítems de activar y de descartar por solicitud. */
export const MAX_CANDIDATAS_LOTE = 1000;

export const GRUPOS_CANDIDATAS = ["propuestas", "sin_criterio", "conflicto", "resueltas"] as const;
export type GrupoCandidatas = (typeof GRUPOS_CANDIDATAS)[number];

/** GET …/reglas/candidatas: llega por query string, así que `limite` acepta texto numérico entero. */
export const filtrosCandidatasSchema = z
  .object({
    grupo: z.enum(GRUPOS_CANDIDATAS).optional(),
    cursor: z.string().min(1).max(256).optional(),
    limite: z
      .union([z.number(), z.string().regex(/^[0-9]{1,3}$/).transform((s) => Number(s))])
      .pipe(z.number().int().min(1).max(200))
      .default(100),
  })
  .strict();
export type FiltrosCandidatas = z.infer<typeof filtrosCandidatasSchema>;

const entero = z.number().int().min(0);

export const ESTADOS_CANDIDATA = ["pendiente", "activada", "descartada", "reemplazada"] as const;
export const CONFLICTOS_CANDIDATA = ["ninguno", "ya_aprendida", "distinto"] as const;

/** El único dato de RUC y razón social viaja dentro de `proveedor`. */
export const candidataVistaSchema = z.object({
  id: z.uuid(),
  proveedor: z.object({ tipo: z.string(), numero: z.string(), razonSocial: z.string().nullable() }),
  destinoPropuesto: destinoCompraSchema.nullable(),
  conteos: z.object({ DG: entero, DGNG: entero, DNG: entero, mixto: entero, total: entero }),
  periodosConProveedor: entero,
  periodosLeidos: entero,
  estado: z.enum(ESTADOS_CANDIDATA),
  destinoElegido: destinoCompraSchema.nullable(),
  regla: z.object({ id: z.uuid(), destino: destinoCompraSchema, version: versionReglaSchema }).nullable(),
  conflicto: z.enum(CONFLICTOS_CANDIDATA),
});
export type CandidataVista = z.infer<typeof candidataVistaSchema>;

/** Ids únicos (sin distinguir mayúsculas) en una lista. */
const sinRepetidos = <T>(clave: (x: T) => string) => (lista: T[], ctx: z.RefinementCtx): void => {
  const vistos = new Set<string>();
  for (const [i, x] of lista.entries()) {
    const k = clave(x).toLowerCase();
    if (vistos.has(k)) {
      ctx.addIssue({ code: "custom", path: [i], message: "id repetido" });
      return;
    }
    vistos.add(k);
  }
};

/** Dos formas que no se mezclan: ítems explícitos (con destino opcional) o «todas» las de una importación. */
export const activarCandidatasSchema = z.union([
  z
    .object({
      items: z
        .array(z.object({ id: z.uuid(), destino: destinoCompraSchema.optional() }).strict())
        .min(1)
        .max(MAX_CANDIDATAS_LOTE)
        .superRefine(sinRepetidos((i: { id: string }) => i.id)),
    })
    .strict(),
  z.object({ todas: z.literal(true), importacionId: z.uuid() }).strict(),
]);
export type ActivarCandidatas = z.infer<typeof activarCandidatasSchema>;

export const MOTIVOS_OMISION_CANDIDATA = ["conflicto", "ya_aprendida", "no_pendiente", "sin_criterio"] as const;
export type MotivoOmisionCandidata = (typeof MOTIVOS_OMISION_CANDIDATA)[number];

export const respuestaActivarSchema = z.object({
  activadas: z.array(z.uuid()),
  omitidas: z.array(z.object({ id: z.uuid(), motivo: z.enum(MOTIVOS_OMISION_CANDIDATA) })),
});
export type RespuestaActivar = z.infer<typeof respuestaActivarSchema>;

/** Reemplazo de la regla viva por el destino de la candidata; la versión es la de la REGLA (no la de la candidata). */
export const reemplazarCandidataSchema = z.object({ destino: destinoCompraSchema.optional(), versionRegla: versionReglaSchema });
export type ReemplazarCandidata = z.infer<typeof reemplazarCandidataSchema>;

/** Respuesta de descartar: las descartadas y las omitidas (ya no pendientes), por id. */
export const respuestaDescartarSchema = z.object({ descartadas: z.array(z.uuid()), omitidas: z.array(z.uuid()) });
export type RespuestaDescartar = z.infer<typeof respuestaDescartarSchema>;

export const descartarCandidatasSchema = z.object({ ids: z.array(z.uuid()).min(1).max(MAX_CANDIDATAS_LOTE) });
export type DescartarCandidatas = z.infer<typeof descartarCandidatasSchema>;
