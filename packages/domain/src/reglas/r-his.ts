// R-HIS (021, RF-086, D-7). Stub de T1 (rojo): la implementación es de T7.
import type { MontosComprobante } from "../comprobante/index";
import type { Destino } from "../comprobante/index";
import type { FilaEvaluable, ReglaAprendidaEvaluable } from "./tipos";

export interface PlanHistorial {
  readonly filaId: string;
  readonly reglaId: string;
  readonly destino: Destino;
  readonly montos: MontosComprobante;
}

export function planificarHistorial(
  filas: readonly FilaEvaluable[],
  reglas: readonly ReglaAprendidaEvaluable[],
  opciones: { readonly rHisActiva: boolean },
): PlanHistorial[] {
  void [filas, reglas, opciones];
  throw new Error("no implementado");
}
