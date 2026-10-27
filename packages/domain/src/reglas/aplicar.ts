// STUB de T4 (tester): T9/T10 implementan la lógica real.
import type { MontosComprobante } from "../comprobante/index";
import type { CodigoRegla, Confirmacion, Hallazgo } from "./tipos";

export function aplicarSugerencia(
  _montos: MontosComprobante,
  _h: Hallazgo,
  _c?: Confirmacion,
): { readonly montos: MontosComprobante; readonly excluir: boolean } {
  throw new Error("no implementado");
}

export function aplicarMasivo(
  _entradas: readonly { montos: MontosComprobante; hallazgo: Hallazgo; confirmacion?: Confirmacion }[],
): {
  readonly aplicadas: readonly { filaId: string; montos: MontosComprobante; excluir: boolean }[];
  readonly rechazadas: readonly { filaId: string; regla: CodigoRegla; codigo: string }[];
} {
  throw new Error("no implementado");
}
