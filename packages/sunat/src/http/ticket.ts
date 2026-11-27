// STUB de 041 · T3 (rojo): T6 lo implementa (plan 041, «ticket.ts»). Solo existe para que las pruebas compilen.
/* eslint-disable @typescript-eslint/no-unused-vars */
export interface ParteTicket {
  nombre: string;
  codTipo: string | null;
}
export type EstadoTicket =
  | { listo: false }
  | { listo: true; codProceso: string; perTributario: string; partes: ParteTicket[] };
export const TOPE_ESPERA_TICKET_MS = 0;
export function interpretarConsultaTicket(_cuerpo: unknown, _numTicket: string): EstadoTicket {
  throw new Error("no implementado: interpretarConsultaTicket");
}
export function planEsperaTicket(): readonly number[] {
  throw new Error("no implementado: planEsperaTicket");
}
