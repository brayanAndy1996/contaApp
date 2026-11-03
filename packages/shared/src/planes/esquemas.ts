import { z } from "zod";

// STUB de T2 (006, pruebas primero): solo tipos del contrato; los esquemas lanzan hasta que T6 los implemente.

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

export type PlanEntrada = Omit<PlanDto, "id">;

const noImplementado = (): never => {
  throw new Error("no implementado (006 T6)");
};
const esquema = <T>(): z.ZodType<T> =>
  ({ safeParse: noImplementado, parse: noImplementado }) as unknown as z.ZodType<T>;

export const planCrearSchema = esquema<PlanEntrada>();
export const planEditarSchema = esquema<PlanEntrada>();
export const suscripcionAsignarSchema = esquema<{
  planId: string;
  rucsExtraContratados: number;
}>();
export const registroSolicitudSchema = esquema<{
  estudio: string;
  ruc?: string | undefined;
  nombre: string;
  correo: string;
}>();
export const registroConsultarSchema = esquema<{ token: string }>();
export const registroConfirmarSchema = esquema<{
  token: string;
  contrasena: string;
}>();
export const registroConfirmarConSesionSchema = esquema<{ token: string }>();
