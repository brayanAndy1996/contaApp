// Tipos comunes de la cola (spec 008). El índice de `@contapp/queue` no importa `bullmq`: el puerto
// `AgregarACola` lo implementa `@contapp/queue/worker`.
import type { ContappDb, TrabajoFila } from "@contapp/db";
import type { Redis } from "ioredis";

export const COLAS = [
  "sire",
  "sol",
  "xml",
  "archivos",
  "programados",
  "notificaciones",
] as const;
export type NombreCola = (typeof COLAS)[number];

export const CANALES = ["sire", "sol", "ninguno"] as const;
export type Canal = (typeof CANALES)[number];

export type CredencialRequerida = "sol" | "sire_api" | null;

/** Reloj inyectable (plan 008, "Pruebas de tiempo"). */
export interface Reloj {
  ahora(): Date;
}

/** Comandos de Redis que usa `queue` (subconjunto de ioredis, sin Lua). */
export type ClienteRedis = Pick<
  Redis,
  | "get"
  | "set"
  | "del"
  | "exists"
  | "pexpire"
  | "sadd"
  | "srem"
  | "smembers"
  | "zadd"
  | "zrem"
  | "zcard"
  | "zscore"
  | "zremrangebyscore"
  | "publish"
>;

/** Lo que `queue` necesita de `ContappDb`. */
export type DbCola = Pick<ContappDb, "withTenant" | "withSistema">;

/** Datos de un trabajo que el despachador usa (subconjunto de `TrabajoFila`). */
export type TrabajoDespacho = Pick<
  TrabajoFila,
  | "id"
  | "tenantId"
  | "clienteId"
  | "ruc"
  | "tipo"
  | "cola"
  | "canal"
  | "prioridad"
  | "creadoPor"
  | "creadoEn"
  | "intentos"
>;

/** Payload que viaja por BullMQ: solo identificadores (CA-15). */
export interface PayloadTrabajo {
  jobId: string;
  tenantId: string;
  tipo: string;
}

/** Puerto hacia BullMQ (`@contapp/queue/worker` lo implementa). */
export type AgregarACola = (
  cola: NombreCola,
  payload: PayloadTrabajo,
) => Promise<void>;

/** Arriendo de cupos, lock de RUC y liderazgo (D5): 30 s, renovado cada 10 s. */
export const ARRIENDO_MS = 30_000;
export const LATIDO_MS = 10_000;
/** Recarga de `config_sistema` (CA-4). */
export const RECARGA_CONFIG_MS = 10_000;
export const PREFIJO_POR_DEFECTO = "contapp:";

/**
 * Registro de fallos sin datos: solo un texto fijo. Nunca recibe el error (su `message` puede traer
 * datos de conexión o de entrada, CA-16).
 */
export function registrarFallo(donde: string): void {
  console.warn(`[queue] ${donde}`);
}
