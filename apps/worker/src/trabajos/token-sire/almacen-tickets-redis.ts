// STUB de 041 · T4 (rojo): T7 lo implementa (plan 041, «Archivos del worker»). Solo existe para que las pruebas compilen.
import type { Redis } from "ioredis";

export interface OpcionesAlmacenTicketsRedis {
  redis: Pick<Redis, "get" | "set" | "del">;
  prefijo?: string;
}

const NO_IMPLEMENTADO = "no implementado";

export class AlmacenTicketsRedis {
  constructor(readonly opciones: OpcionesAlmacenTicketsRedis) {}
  leer(clave: string): Promise<string | null> {
    return Promise.reject(new Error(`${NO_IMPLEMENTADO}: leer ${clave.length}`));
  }
  guardar(clave: string, numTicket: string, ttlMs: number): Promise<void> {
    return Promise.reject(
      new Error(`${NO_IMPLEMENTADO}: guardar ${clave.length}${numTicket.length}${ttlMs}`),
    );
  }
  borrar(clave: string): Promise<void> {
    return Promise.reject(new Error(`${NO_IMPLEMENTADO}: borrar ${clave.length}`));
  }
}
