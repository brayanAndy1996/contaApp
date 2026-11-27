// STUB de 041 · T3 (rojo): T6 lo implementa (plan 041, «sire-auth.http.ts»). Solo existe para que las pruebas compilen.
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { CredencialSire, SireAuth, TokenSire } from "../puertos.js";
import type { AlmacenTicketsSire } from "./almacen-tickets.js";

export interface OpcionesHttpSire {
  fetch?: typeof fetch;
  ahora?: () => Date;
  dormir?: (ms: number) => Promise<void>;
  almacenTickets?: AlmacenTicketsSire;
  urlsDePrueba?: { seguridad: string; sire: string };
}

export class HttpSireAuth implements SireAuth {
  constructor(_o?: OpcionesHttpSire) {}
  obtenerToken(_credencial: CredencialSire): Promise<TokenSire> {
    return Promise.reject(new Error("no implementado: HttpSireAuth.obtenerToken"));
  }
}
