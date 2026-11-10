import { esquemaPendiente } from "../archivos/pendiente.js";

// Stub de T2 (012b): excluir y restaurar ventas (D12, P-8), exclusión en `VentaDto` y resumen con estado. Lo implementa T8.
export interface ExclusionVenta {
  motivo: string;
  por: string;
  en: string;
}
export const excluirVentaSchema = esquemaPendiente<{ motivo: string }>();
export const restaurarVentaSchema = esquemaPendiente<Record<string, never>>();
export const exclusionVentaSchema = esquemaPendiente<ExclusionVenta | null>();
export const resumenVentasSchema = esquemaPendiente<Record<string, unknown>>();
