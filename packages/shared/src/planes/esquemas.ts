import { z } from "zod";

/** Contrato de plan.md (Contratos: shared). Precios como cadena decimal; sin `number` para dinero. */
export interface PlanDto {
  id: string;
  codigo: string;
  nombre: string;
  precioMensual: string;
  precioAnual: string | null;
  maxRucs: number;
  maxUsuarios: number | null;
  precioRucExtra: string;
  maxRucsExtra: number;
  frecuenciaBuzonMin: number;
  features: Record<string, unknown>;
  activo: boolean;
}

/** Uso del plan del estudio (D8): sin precios. */
export interface UsoPlanDto {
  plan: { codigo: string; nombre: string };
  estado: "prueba" | "activa";
  pruebaVenceEn: string | null;
  rucs: { usados: number; limite: number; libres: number; extra: number };
  usuarios: { usados: number; pendientes: number; limite: number | null };
}

/** Plan sin identificador: lo que el super-admin envía al crear o reemplazar (activo ya resuelto). */
export type PlanEntrada = Omit<PlanDto, "id">;

const FEATURES_MAX_BYTES = 4096;
const TEXTO_MAX = 200;
const CORREO_MAX = 320;

/** Precio como cadena decimal con hasta 2 decimales (`\d` es ASCII en JS); nunca `number` para dinero. */
const precioSchema = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);

const featuresSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (f) => new TextEncoder().encode(JSON.stringify(f)).length <= FEATURES_MAX_BYTES,
  );

// `z.object` descarta las claves desconocidas (id, tenantId, etc. no viajan por el cuerpo).
const planBase = z.object({
  codigo: z.string().min(1).max(TEXTO_MAX),
  nombre: z.string().min(1).max(TEXTO_MAX),
  precioMensual: precioSchema,
  precioAnual: precioSchema.nullable(),
  maxRucs: z.int().min(1),
  maxUsuarios: z.int().min(1).nullable(),
  precioRucExtra: precioSchema,
  maxRucsExtra: z.int().min(0),
  frecuenciaBuzonMin: z.int().min(1),
  features: featuresSchema,
});

/** Los adicionales no pueden pasar del 20 % de los RUCs del plan (D6). */
const topeAdicionales = {
  check: (p: { maxRucs: number; maxRucsExtra: number }) =>
    p.maxRucsExtra * 5 <= p.maxRucs,
  opciones: { path: ["maxRucsExtra"], error: "maxRucsExtra excede el 20 % de maxRucs" },
};

/** POST /plataforma/planes: `activo` es opcional y vale `true`. */
export const planCrearSchema = planBase
  .extend({ activo: z.boolean().default(true) })
  .refine(topeAdicionales.check, topeAdicionales.opciones);

/** PUT /plataforma/planes/:planId: reemplazo completo, `activo` obligatorio. */
export const planEditarSchema = planBase
  .extend({ activo: z.boolean() })
  .refine(topeAdicionales.check, topeAdicionales.opciones);

export const suscripcionAsignarSchema = z.object({
  planId: z.uuid(),
  rucsExtraContratados: z.int().min(0),
});

export const registroSolicitudSchema = z.object({
  estudio: z.string().min(1).max(TEXTO_MAX),
  ruc: z.string().regex(/^\d{11}$/).optional(),
  nombre: z.string().min(1).max(TEXTO_MAX),
  correo: z.string().min(1).max(CORREO_MAX),
});

export const registroConsultarSchema = z.object({ token: z.string() });

export const registroConfirmarSchema = z.object({
  token: z.string(),
  contrasena: z.string(),
});

export const registroConfirmarConSesionSchema = z.object({ token: z.string() });
