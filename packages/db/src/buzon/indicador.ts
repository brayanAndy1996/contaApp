// STUB de la spec 024 · T3 (rojo). La implementación real (agregado de nuevos por cliente) es la tarea T7.
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { TxConsulta } from "./errores";

export interface IndicadorBuzon {
  nuevos: number;
  criticosNuevos: number;
}

export async function indicadorBuzon(
  _tx: TxConsulta,
  _clienteIds: string[],
): Promise<Map<string, IndicadorBuzon>> {
  throw new Error("no implementado: indicadorBuzon (spec 024 T7)");
}
