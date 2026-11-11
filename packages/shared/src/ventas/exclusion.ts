import { z } from "zod";
import { estadoPeriodoSchema, MOTIVO_EXCLUSION_MAX, montoDecimalSchema, sinControles } from "../compras/esquemas.js";

// Spec 012b (D12, P-8). Excluir y restaurar ventas del SIRE con error de fila; `exclusion` en `VentaDto`; resumen con estado.

/** `POST …/ventas/:id/excluir`. Estricto; el motivo se recorta y queda de 1 a 200 caracteres sin controles. */
export const excluirVentaSchema = z.strictObject({
  motivo: z.string().trim().min(1).max(MOTIVO_EXCLUSION_MAX).refine(sinControles),
});
export type ExcluirVentaInput = z.infer<typeof excluirVentaSchema>;

/** `POST …/ventas/:id/restaurar`: cuerpo vacío y estricto. */
export const restaurarVentaSchema = z.strictObject({});

const exclusionVigenteSchema = z.object({ motivo: z.string(), por: z.uuid(), en: z.iso.datetime() });
export type ExclusionVenta = z.infer<typeof exclusionVigenteSchema>;
/** Lo que lleva `VentaDto.exclusion`: la exclusión vigente o null. */
export const exclusionVentaSchema = exclusionVigenteSchema.nullable();

const montosResumenSchema = z.object({
  baseGravada: montoDecimalSchema,
  igv: montoDecimalSchema,
  exonerada: montoDecimalSchema,
  inafecta: montoDecimalSchema,
  isc: montoDecimalSchema,
  icbper: montoDecimalSchema,
  otros: montoDecimalSchema,
  total: montoDecimalSchema,
});
const cantidad = z.number().int().min(0);

/** `GET …/ventas/resumen`: la forma de `ResumenVentasDto` (013) más `estado` y `excluidas` (cantidad; no suman). */
export const resumenVentasSchema = z.object({
  porTipo: z.array(montosResumenSchema.extend({ tipo: z.string(), cantidad })),
  total: montosResumenSchema.extend({ cantidad }),
  sinConvertir: z.array(z.object({ clave: z.string(), moneda: z.string() })),
  avisos: z.array(z.literal("usd_sin_tipo_cambio")),
  estado: estadoPeriodoSchema,
  excluidas: cantidad,
});
export type ResumenVentasVista = z.infer<typeof resumenVentasSchema>;
