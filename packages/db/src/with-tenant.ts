// withTenant / withUsuario: cada llamada es UNA transacción en una conexión del pool con
//   <limpiar sesión>; BEGIN; SET LOCAL ROLE <rolApp>; SELECT set_config(..., true) ...; fn(tx);
//   COMMIT | ROLLBACK; <limpiar sesión>
// Lo que fijamos es LOCAL a la transacción, y lo que `fn` haya fijado a nivel de sesión se limpia al
// liberar: la conexión vuelve al pool como contapp_app sin contexto (si la limpieza falla, se destruye).
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

/**
 * Valida el contexto de withUsuario (P7): solo app.user_id; app.tenant_id queda sin fijar. Que no
 * arrastre un valor de sesión anterior (H1) lo garantiza LIMPIAR_SESION antes de BEGIN.
 */
export function ajusteUsuario(ctx: unknown): Ajuste {
  if (typeof ctx !== "object" || ctx === null) throw new ContextoInvalidoError();
  const { userId } = ctx as { userId?: unknown };
  if (!uuidValido(userId)) throw new ContextoInvalidoError();
  return {
    sql: "SELECT set_config('app.user_id', $1, true)",
    valores: [userId.toLowerCase()],
  };
}

/**
 * Limpia el estado de SESIÓN que `fn` pudo dejar en la conexión (set_config(..., false), SET ROLE
 * o SET de sesión, cursores WITH HOLD, LISTEN, advisory locks de sesión) para que no se herede en
 * la siguiente petición del pool (H1, H8). `RESET ALL` no incluye `role`, de ahí el `RESET ROLE`.
 * `DEALLOCATE ALL` (H11) borra también las sentencias creadas con PREPARE por SQL (incluso desde
 * DO/EXECUTE), que podrían devolver datos de otro estudio o suplantar una sentencia con nombre de
 * `pg`; por eso, tras la limpieza, se vacía la caché de sentencias de `pg` (olvidarSentencias) y
 * `pg` las vuelve a preparar cuando haga falta. No se usa DISCARD ALL (incluiría DISCARD TEMP/PLANS,
 * innecesarios aquí). Se envía antes de BEGIN (conexiones sucias de fuera de withTenant) y al liberar.
 */
const LIMPIAR_SESION =
  "CLOSE ALL; RESET ROLE; RESET ALL; UNLISTEN *; DEALLOCATE ALL; SELECT pg_advisory_unlock_all()";

/** Intentos de obtener del pool una conexión sin transacción abierta antes de fallar cerrado. */
const MAX_INTENTOS_CONEXION = 10;

/**
 * H12: `pg` no hace ROLLBACK al liberar, así que una conexión usada fuera de withTenant puede volver
 * al pool con una transacción abierta (`T`) o abortada (`E`). Se consulta el estado que informa el
 * propio protocolo (ReadyForQuery), sin enviar nada al servidor.
 */
function tieneTransaccionAbierta(client: PoolClient): boolean {
  const estado = (client as { getTransactionStatus?: () => string | null }).getTransactionStatus;
  if (typeof estado !== "function") return false;
  const s = estado.call(client);
  return s === "T" || s === "E";
}

/** Tras DEALLOCATE ALL, `pg` no debe creer que sus sentencias con nombre siguen preparadas. */
function olvidarSentencias(client: PoolClient): void {
  const conexion = (client as { connection?: { parsedStatements?: Record<string, string> } })
    .connection;
  if (conexion !== undefined && typeof conexion.parsedStatements === "object") {
    conexion.parsedStatements = {};
  }
}

/**
 * Pide una conexión al pool; si llega con una transacción ajena abierta, la destruye (no se ejecuta
 * nada dentro de ella: ni se confirma ni se revierte trabajo de otra petición) y pide otra.
 */
async function conexionSinTransaccion(pool: Pool): Promise<PoolClient> {
  for (let i = 0; i < MAX_INTENTOS_CONEXION; i++) {
    const client = await pool.connect();
    if (!tieneTransaccionAbierta(client)) return client;
    client.release(new Error("conexión del pool con una transacción abierta"));
  }
  throw new Error("No se obtuvo del pool una conexión sin transacción abierta");
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

  const client = await conexionSinTransaccion(pool);
  let terminada = false;
  let conexionRota: Error | undefined;
  try {
    await client.query(LIMPIAR_SESION);
    olvidarSentencias(client);
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
    if (conexionRota === undefined) {
      try {
        await client.query(LIMPIAR_SESION);
        olvidarSentencias(client);
        if (tieneTransaccionAbierta(client)) {
          conexionRota = new Error("la conexión quedó con una transacción abierta");
        }
      } catch (errLimpieza) {
        // No se pudo garantizar una sesión limpia: la conexión no vuelve al pool.
        conexionRota =
          errLimpieza instanceof Error ? errLimpieza : new Error("limpieza de sesión fallida");
      }
    }
    client.release(conexionRota);
  }
}
