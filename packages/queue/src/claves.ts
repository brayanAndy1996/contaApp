// Claves Redis y deduplicación (plan 008, D8). Funciones puras.
import { createHash } from "node:crypto";
import { PREFIJO_POR_DEFECTO, type Canal, type NombreCola } from "./tipos.js";

function canon(v: unknown): string {
  if (v !== null && typeof v === "object") {
    const conJson = v as { toJSON?: () => unknown };
    if (typeof conJson.toJSON === "function") return canon(conJson.toJSON());
    if (Array.isArray(v)) {
      return `[${v.map((x) => (x === undefined ? "null" : canon(x))).join(",")}]`;
    }
    const o = v as Record<string, unknown>;
    const claves = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${claves.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** JSON con las claves de cada objeto ordenadas y sin espacios; los arreglos conservan su orden. */
export function jsonCanonico(v: unknown): string {
  return canon(v);
}

/**
 * SHA-256 (32 B) de [tipo, cliente, parámetros] en JSON canónico: sin colisiones por concatenación. El id del cliente va en
 * minúsculas (H-023-1-1): PostgreSQL acepta el UUID en cualquier grafía y el programador calcula la clave en SQL con `uuid::text`
 * (minúsculas); las claves ya guardadas no cambian porque siempre se calcularon con el id que devuelve la BD.
 */
export function claveDedupe(
  tipo: string,
  clienteId: string,
  parametros: unknown,
): Buffer {
  return createHash("sha256")
    .update(
      jsonCanonico([tipo, clienteId.toLowerCase(), parametros ?? null]),
      "utf8",
    )
    .digest();
}

export interface ClavesCola {
  pend(cola: NombreCola | string, tenantId: string): string;
  tenants(cola: NombreCola | string): string;
  cupoTenant(cola: NombreCola | string, tenantId: string): string;
  cupoGlobal(cola: NombreCola | string): string;
  lockRuc(canal: Canal | string, ruc: string): string;
  lider(cola: NombreCola | string): string;
  ejec(jobId: string): string;
  eventos(tenantId: string): string;
  tokenSire(proceso: string, tenantId: string, clienteId: string): string;
  /** Ticket del SIRE pendiente (041): estudio Y cliente en la clave; el valor es solo el número de ticket. */
  ticketSire(
    tenantId: string,
    clienteId: string,
    libro: LibroTicketSire,
    periodo: string,
    operacion: OperacionTicketSire,
  ): string;
}

export type LibroTicketSire = "compras" | "ventas";
/**
 * `propuesta` = descarga de la propuesta (013); `registro` = registro presentado (025), una sola solicitud y un ticket por
 * periodo (plan 041, P-3: `codMoneda` no filtra). Ninguna contiene `:`, así que la clave sigue teniendo 5 partes tras el prefijo.
 */
export type OperacionTicketSire = "propuesta" | "registro";

/** Constructores de claves; el prefijo se antepone tal cual (incluye los dos puntos). */
export function crearClaves(prefijo: string = PREFIJO_POR_DEFECTO): ClavesCola {
  return {
    pend: (cola, tenantId) => `${prefijo}pend:${cola}:${tenantId}`,
    tenants: (cola) => `${prefijo}tenants:${cola}`,
    cupoTenant: (cola, tenantId) => `${prefijo}cupo:${cola}:${tenantId}`,
    cupoGlobal: (cola) => `${prefijo}cupo:${cola}`,
    lockRuc: (canal, ruc) => `${prefijo}lock:ruc:${canal}:${ruc}`,
    lider: (cola) => `${prefijo}lider:${cola}`,
    ejec: (jobId) => `${prefijo}ejec:${jobId}`,
    eventos: (tenantId) => `${prefijo}eventos:${tenantId}`,
    tokenSire: (proceso, tenantId, clienteId) =>
      `${prefijo}sire:token:${proceso}:${tenantId}:${clienteId}`,
    ticketSire: (tenantId, clienteId, libro, periodo, operacion) =>
      `${prefijo}sire:ticket:${tenantId}:${clienteId}:${libro}:${periodo}:${operacion}`,
  };
}
