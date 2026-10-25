// Soporte común de la suite de aislamiento (spec 002). Solo usa DATABASE_URL y @contapp/db.
//
// Supuestos de contrato que la implementación (T5/T6) debe cumplir:
// - `Tx` expone `query(text, values?)` estilo `pg` ({ rows, rowCount }).
// - `SEED` expone la forma de `SeedEsperado` (IDs fijos; 3 clientes por tenant; un RUC repetido en A y B).
import * as dbModule from "@contapp/db";
import { Pool } from "pg";

export type RolApp = "contapp_backend" | "contapp_worker";
export const ROLES_APP: RolApp[] = ["contapp_backend", "contapp_worker"];
export const TABLAS_NEGOCIO = ["membresia", "cliente"] as const;
export type TablaNegocio = (typeof TABLAS_NEGOCIO)[number];

export interface Resultado {
  rows: any[];
  rowCount: number | null;
}
export interface Tx {
  query(text: string, values?: unknown[]): Promise<Resultado>;
}
export interface ContextoTenant {
  tenantId: string;
  userId?: string;
}
export interface ContappDb {
  withTenant<T>(ctx: ContextoTenant, fn: (tx: Tx) => Promise<T>): Promise<T>;
  withUsuario<T>(ctx: { userId: string }, fn: (tx: Tx) => Promise<T>): Promise<T>;
  pool: Pool;
  close(): Promise<void>;
}
export interface FilaCliente {
  id: string;
  ruc: string;
}
export interface SeedEsperado {
  tenantA: string;
  tenantB: string;
  uA: string;
  uB: string;
  uAB: string;
  clientesA: FilaCliente[];
  clientesB: FilaCliente[];
  rucRepetido: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Estudio = "A" | "B";
export const otro = (e: Estudio): Estudio => (e === "A" ? "B" : "A");

export function semilla(): SeedEsperado {
  const s = (dbModule as unknown as { SEED?: SeedEsperado }).SEED;
  if (!s) {
    throw new Error("@contapp/db aun no exporta SEED (implementacion pendiente, T5/T6)");
  }
  for (const k of ["tenantA", "tenantB", "uA", "uB", "uAB"] as const) {
    if (!UUID.test(String(s[k]))) throw new Error(`SEED.${k} no es un UUID`);
  }
  for (const k of ["clientesA", "clientesB"] as const) {
    if (!Array.isArray(s[k]) || s[k].length !== 3) throw new Error(`SEED.${k} debe tener 3 clientes`);
  }
  return s;
}

export const tenantDe = (e: Estudio): string => (e === "A" ? semilla().tenantA : semilla().tenantB);
export const clientesDe = (e: Estudio): FilaCliente[] => (e === "A" ? semilla().clientesA : semilla().clientesB);
/** Usuario del seed que NO es miembro del estudio dado (sirve para INSERT en membresia). */
export const usuarioNoMiembro = (e: Estudio): string => (e === "A" ? semilla().uB : semilla().uA);

export function crearDb(rolApp: RolApp, poolMax?: number): ContappDb {
  const f = (dbModule as unknown as { createDb?: (o: object) => ContappDb }).createDb;
  if (typeof f !== "function") {
    throw new Error("@contapp/db aun no exporta createDb (implementacion pendiente, T6)");
  }
  return f({ rolApp, ...(poolMax ? { poolMax } : {}) });
}

export function abrirPool(max = 2): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("falta DATABASE_URL");
  return new Pool({ connectionString, max });
}

class Revertir extends Error {}

/** Ejecuta `fn` dentro de withTenant y siempre revierte la transaccion (ningun cambio persiste). */
export async function enRollback<T>(db: ContappDb, ctx: ContextoTenant, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let salida: T | undefined;
  try {
    await db.withTenant(ctx, async (tx) => {
      salida = await fn(tx);
      throw new Revertir();
    });
  } catch (e) {
    if (!(e instanceof Revertir)) throw e;
  }
  return salida as T;
}

export type Intento = { ok: true; rowCount: number } | { ok: false; code: string; message: string };

/** Una sentencia dentro de withTenant (con rollback); devuelve el error de PG en vez de lanzarlo. */
export async function intentar(
  db: ContappDb,
  ctx: ContextoTenant,
  text: string,
  values: unknown[] = [],
): Promise<Intento> {
  return enRollback(db, ctx, (tx) => capturar(tx, text, values));
}

async function capturar(tx: Tx, text: string, values: unknown[]): Promise<Intento> {
  try {
    const r = await tx.query(text, values);
    return { ok: true, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: String(err.code ?? ""), message: String(err.message ?? "") };
  }
}

/** Una sentencia en el pool crudo, con `SET LOCAL ROLE` opcional, siempre con ROLLBACK. */
export async function intentarRaw(
  pool: Pool,
  rol: string | null,
  text: string,
  values: unknown[] = [],
): Promise<Intento> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (rol) {
      if (!/^contapp_[a-z]+$/.test(rol)) throw new Error("rol invalido en la prueba");
      await c.query(`SET LOCAL ROLE ${rol}`);
    }
    return await capturar(c, text, values);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

/** Filas (no solo conteo) de una consulta en el pool crudo con SET LOCAL ROLE opcional. */
export async function filasRaw(pool: Pool, rol: string | null, text: string, values: unknown[] = []): Promise<any[]> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (rol) {
      if (!/^contapp_[a-z]+$/.test(rol)) throw new Error("rol invalido en la prueba");
      await c.query(`SET LOCAL ROLE ${rol}`);
    }
    return (await c.query(text, values)).rows;
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

/** IDs de una tabla de negocio visibles para el estudio `e` (leidos dentro de su propio tenant). */
export async function idsDe(db: ContappDb, e: Estudio, tabla: TablaNegocio): Promise<string[]> {
  return db.withTenant({ tenantId: tenantDe(e) }, async (tx) => {
    const r = await tx.query(`select id from ${tabla} order by id`);
    return r.rows.map((x) => x.id as string);
  });
}
