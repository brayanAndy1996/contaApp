// STUB de 041 · T3 (rojo): T6 lo implementa (plan 041, «almacen-tickets.ts»). Solo existe para que las pruebas compilen.
/* eslint-disable @typescript-eslint/no-unused-vars */
export interface AlmacenTicketsSire {
  leer(clave: string): Promise<string | null>;
  guardar(clave: string, numTicket: string, ttlMs: number): Promise<void>;
  borrar(clave: string): Promise<void>;
}
export class AlmacenTicketsMemoria implements AlmacenTicketsSire {
  constructor(_ahora?: () => Date) {
    throw new Error("no implementado: AlmacenTicketsMemoria");
  }
  leer(_clave: string): Promise<string | null> {
    return Promise.reject(new Error("no implementado"));
  }
  guardar(_clave: string, _numTicket: string, _ttlMs: number): Promise<void> {
    return Promise.reject(new Error("no implementado"));
  }
  borrar(_clave: string): Promise<void> {
    return Promise.reject(new Error("no implementado"));
  }
}
