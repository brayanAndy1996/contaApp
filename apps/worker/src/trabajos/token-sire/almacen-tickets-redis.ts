// `AlmacenTicketsSire` sobre Redis (spec 041, P-4 c): guarda el número de ticket de un reporte del SIRE que no terminó dentro del
// presupuesto, para retomarlo en el siguiente intento sin exportar de nuevo. El valor es SOLO el número de ticket (no es un secreto;
// nunca token ni credenciales). La clave que entrega `HttpSireApiClient` es `{tenant}:{cliente}:{libro}:{periodo}:{operacion}` y se
// guarda en `crearClaves(prefijo).ticketSire(...)`: estudio Y cliente en la clave.
import { crearClaves, type ClavesCola } from "@contapp/queue";
import type { AlmacenTicketsSire } from "@contapp/sunat";
import type { Redis } from "ioredis";

export interface OpcionesAlmacenTicketsRedis {
  redis: Pick<Redis, "get" | "set" | "del">;
  prefijo?: string;
}

const LIBROS = ["compras", "ventas"] as const;
const OPERACIONES = ["propuesta", "registro"] as const;

export class AlmacenTicketsRedis implements AlmacenTicketsSire {
  private readonly redis: OpcionesAlmacenTicketsRedis["redis"];
  private readonly k: ClavesCola;

  constructor(o: OpcionesAlmacenTicketsRedis) {
    this.redis = o.redis;
    this.k = crearClaves(o.prefijo);
  }

  async leer(clave: string): Promise<string | null> {
    return this.redis.get(this.claveRedis(clave));
  }

  async guardar(clave: string, numTicket: string, ttlMs: number): Promise<void> {
    await this.redis.set(
      this.claveRedis(clave),
      numTicket,
      "PX",
      Math.max(1, Math.ceil(ttlMs)),
    );
  }

  async borrar(clave: string): Promise<void> {
    await this.redis.del(this.claveRedis(clave));
  }

  /**
   * `{tenant}:{cliente}:{libro}:{periodo}:{operacion}` → clave de Redis. `HttpSireApiClient` (T6) hoy entrega la clave SIN
   * operación (solo implementa la propuesta: el registro presentado falla antes de tocar la red); sin operación vale `propuesta`.
   * Una clave mal formada es un error de programación.
   */
  private claveRedis(clave: string): string {
    const partes = clave.split(":");
    if (partes.length === 4) partes.push("propuesta");
    const [tenantId, clienteId, libro, periodo, operacion, ...resto] = partes;
    if (
      resto.length > 0 ||
      !tenantId ||
      !clienteId ||
      !periodo ||
      !LIBROS.includes(libro as (typeof LIBROS)[number]) ||
      !OPERACIONES.includes(operacion as (typeof OPERACIONES)[number])
    )
      throw new Error("clave de ticket SIRE inválida");
    return this.k.ticketSire(
      tenantId,
      clienteId,
      libro as (typeof LIBROS)[number],
      periodo,
      operacion as (typeof OPERACIONES)[number],
    );
  }
}
