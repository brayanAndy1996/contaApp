// withTenant / withUsuario: cada llamada es UNA transacción en una conexión del pool con
//   BEGIN; SET LOCAL ROLE <rolApp>; SELECT set_config(..., true) ...; fn(tx); COMMIT | ROLLBACK
// Todo lo fijado es LOCAL a la transacción: al terminar, la conexión vuelve a contapp_app sin contexto.
// El rol sale de una lista cerrada (nunca de la entrada) y los UUID van como parámetros.
// Nunca se registra el contexto ni la URL.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { ContextoInvalidoError, WithTenantAnidadoError } from "./errores";

export type RolApp = "contapp_backend" | "contapp_worker";

export interface ContextoTenant {
  /** UUID del tenant (estudio contable). */
  tenantId: string;
  /** UUID del usuario que actúa (opcional). */
  userId?: string;
}

/** Transacción con contexto fijado. Solo es válida mientras dura la llamada a withTenant/withUsuario. */
export interface Tx {
  /** Consulta estilo `pg` con parámetros posicionales ($1, $2, ...). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R extends QueryResultRow = any>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  /** Query builder de Drizzle sobre la misma transacción. */
  readonly orm: NodePgDatabase;
}

/** Sentencias de rol precalculadas: el texto SQL nunca se arma con datos de entrada. */
const SET_ROLE: Readonly<Record<RolApp, string>> = Object.freeze({
  contapp_backend: "SET LOCAL ROLE contapp_backend",
  contapp_worker: "SET LOCAL ROLE contapp_worker",
});

export function esRolApp(rol: unknown): rol is RolApp {
  return typeof rol === "string" && Object.hasOwn(SET_ROLE, rol);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidValido(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

// Detección de anidamiento compartida por todas las instancias de createDb, incluso si el
// módulo se carga dos veces (src y dist): el almacén vive en un símbolo global.
const CLAVE_ALS = Symbol.for("@contapp/db/with-tenant/als");
type Global = typeof globalThis & { [CLAVE_ALS]?: AsyncLocalStorage<true> };
const g = globalThis as Global;
const enContexto: AsyncLocalStorage<true> = (g[CLAVE_ALS] ??= new AsyncLocalStorage<true>());

function verificarNoAnidado(): void {
  if (enContexto.getStore() === true) throw new WithTenantAnidadoError();
}

interface Ajuste {
  sql: string;
  valores: string[];
}

/** Valida el contexto de withTenant ANTES de abrir conexión. */
export function ajusteTenant(ctx: unknown): Ajuste {
  if (typeof ctx !== "object" || ctx === null) throw new ContextoInvalidoError();
  const { tenantId, userId } = ctx as Partial<ContextoTenant>;
  if (!uuidValido(tenantId)) throw new ContextoInvalidoError();
  if (userId !== undefined && !uuidValido(userId)) throw new ContextoInvalidoError();
  return {
    sql: "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    valores: [tenantId.toLowerCase(), userId === undefined ? "" : userId.toLowerCase()],
  };
}

/** Valida el contexto de withUsuario (P7): solo app.user_id; app.tenant_id queda sin fijar. */
export function ajusteUsuario(ctx: unknown): Ajuste {
  if (typeof ctx !== "object" || ctx === null) throw new ContextoInvalidoError();
  const { userId } = ctx as { userId?: unknown };
  if (!uuidValido(userId)) throw new ContextoInvalidoError();
  return {
    sql: "SELECT set_config('app.user_id', $1, true)",
    valores: [userId.toLowerCase()],
  };
}

function crearTx(client: PoolClient, cerrada: () => boolean): Tx {
  const query = (text: string, values?: unknown[]) => {
    if (cerrada()) {
      return Promise.reject(new Error("La transacción de withTenant ya terminó"));
    }
    return client.query(text, values);
  };
  // Drizzle recibe un cliente acotado que también deja de funcionar al cerrar la transacción.
  const acotado = {
    query: (...args: unknown[]) => {
      if (cerrada()) {
        return Promise.reject(new Error("La transacción de withTenant ya terminó"));
      }
      return (client.query as (...a: unknown[]) => unknown)(...args);
    },
  };
  let orm: NodePgDatabase | undefined;
  return {
    query: query as Tx["query"],
    get orm() {
      return (orm ??= drizzle({ client: acotado as unknown as PoolClient }));
    },
  };
}

/**
 * Ejecuta `fn` en una transacción con el rol y el contexto indicados.
 * `preparar` valida la entrada (lanza ContextoInvalidoError) antes de pedir una conexión.
 */
export async function ejecutarEnContexto<T>(
  pool: Pool,
  rolApp: RolApp,
  preparar: () => Ajuste,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  verificarNoAnidado();
  const ajuste = preparar();
  if (!esRolApp(rolApp)) throw new ContextoInvalidoError();

  const client = await pool.connect();
  let terminada = false;
  let conexionRota: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query(SET_ROLE[rolApp]);
    await client.query(ajuste.sql, ajuste.valores);
    const tx = crearTx(client, () => terminada);
    const resultado = await enContexto.run(true, () => fn(tx));
    terminada = true;
    await client.query("COMMIT");
    return resultado;
  } catch (e) {
    terminada = true;
    try {
      await client.query("ROLLBACK");
    } catch (errRollback) {
      // Estado desconocido: se destruye la conexión en lugar de devolverla al pool.
      conexionRota = errRollback instanceof Error ? errRollback : new Error("rollback fallido");
    }
    throw e;
  } finally {
    terminada = true;
    client.release(conexionRota);
  }
}
