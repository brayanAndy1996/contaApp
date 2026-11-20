// STUB de la spec 024 · T3 (rojo). La implementación real (llamada a buzon_atencion_aplicar) es la tarea T7.
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { TxConsulta } from "./errores";

export interface EntradaAtencionBuzon {
  accion: "marcar" | "deshacer";
  mensajes: string[];
  /** Ruta individual: el cliente al que deben pertenecer todos los mensajes; sin él (lote) la función recibe NULL. */
  clienteId?: string;
  comentario?: string | null;
}

export interface ResultadoAtencionBuzon {
  mensajeId: string;
  aplicado: boolean;
  atendidoPor: string | null;
  atendidoEn: Date | null;
}

export async function aplicarAtencionBuzon(
  _tx: TxConsulta,
  _entrada: EntradaAtencionBuzon,
): Promise<ResultadoAtencionBuzon[]> {
  throw new Error("no implementado: aplicarAtencionBuzon (spec 024 T7)");
}
