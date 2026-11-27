// STUB de 041 · T3 (rojo): T6 lo implementa (plan 041, «transporte.ts»). Solo existe para que las pruebas compilen.
/* eslint-disable @typescript-eslint/no-unused-vars */
export type ContextoHttp = "token" | "api";
export interface PeticionTransporte {
  url: string;
  metodo: "GET" | "POST";
  cabeceras?: Record<string, string>;
  cuerpo?: string;
  contexto: ContextoHttp;
  timeoutMs: number;
  maxBytes: number;
  fetch?: typeof fetch;
}
export interface RespuestaTransporte {
  estado: number;
  cabeceras: Record<string, string>;
  cuerpo: Uint8Array;
}
export function pedir(_p: PeticionTransporte): Promise<RespuestaTransporte> {
  return Promise.reject(new Error("no implementado: pedir"));
}
