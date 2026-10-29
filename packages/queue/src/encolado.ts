// Encolado con outbox (D3, D8, CA-1, CA-15). `encolar` solo escribe en BD dentro de la transacción del
// caso de uso; `publicar` va después del commit y fuera del callback de withTenant.
import {
  contarPendientes,
  insertarTrabajo,
  leerCliente,
  leerConfig,
  trabajoVivoPorClave,
  type Tx,
} from "@contapp/db";
import {
  PRIORIDADES,
  type Prioridad,
  type TrabajoVista,
} from "@contapp/shared";
import { definicionDe } from "./catalogo.js";
import { claveDedupe, crearClaves } from "./claves.js";
import {
  ClienteDesconocidoError,
  ColaLlenaError,
  ColaNoConfiguradaError,
  ParametrosInvalidosError,
} from "./errores.js";
import {
  registrarFallo,
  type ClienteRedis,
  type NombreCola,
  type PayloadTrabajo,
  type TrabajoDespacho,
} from "./tipos.js";

export interface EntradaEncolar {
  tipo: string;
  clienteId: string;
  parametros: unknown;
  prioridad: Prioridad;
  creadoPor: string | null;
}

export interface ResultadoEncolar {
  trabajo: TrabajoVista;
  nuevo: boolean;
}

type TxEncolar = Pick<Tx, "query">;

/**
 * Inserta el trabajo `en_cola` (o devuelve el vivo con la misma clave, D8). Persiste los parámetros
 * PARSEADOS (las claves desconocidas se descartan). Lanza sin insertar: TipoDesconocidoError,
 * ParametrosInvalidosError, ColaNoConfiguradaError, ColaLlenaError, ClienteDesconocidoError.
 */
export async function encolar(
  tx: TxEncolar,
  e: EntradaEncolar,
): Promise<ResultadoEncolar> {
  const def = definicionDe(e.tipo);
  if (!(PRIORIDADES as readonly string[]).includes(e.prioridad)) {
    throw new ParametrosInvalidosError();
  }
  const r = def.parametros.safeParse(e.parametros);
  if (!r.success) throw new ParametrosInvalidosError();
  const parametros = r.data;
  const clave = claveDedupe(def.tipo, e.clienteId, parametros);

  const vivo = await trabajoVivoPorClave(tx, clave);
  if (vivo !== null) return { trabajo: vivo, nuevo: false };

  const config = (await leerConfig(tx)).get(def.cola);
  if (config === undefined) throw new ColaNoConfiguradaError();
  if ((await contarPendientes(tx, def.cola)) >= config.maxPendientesTenant) {
    throw new ColaLlenaError();
  }
  const cliente = await leerCliente(tx, e.clienteId);
  if (cliente === null) throw new ClienteDesconocidoError();

  const nuevo = {
    clienteId: e.clienteId,
    ruc: cliente.ruc,
    tipo: def.tipo,
    cola: def.cola,
    canal: def.canal,
    prioridad: e.prioridad,
    parametros,
    claveDedupe: clave,
    creadoPor: e.creadoPor,
    // Ejecuciones totales = 1 + reintentos (CHECK max_intentos >= 1).
    maxIntentos: config.reintentos + 1,
    // El conteo de arriba es un rechazo temprano; el tope atómico lo aplica el INSERT (H-008-2a-3).
    maxPendientes: config.maxPendientesTenant,
  };
  // Encolado concurrente de lo mismo (H-008-1a-2): si otra transacción insertó antes la misma clave viva, el INSERT no
  // lanza 23505 sino que no devuelve fila y se relee el vivo (D8). Si entretanto el vivo ya terminó, se reintenta sin
  // ON CONFLICT: si otra transacción reintenta a la vez, su 23505 vuelve al savepoint del repo como null y se relee su
  // trabajo (H-008-2b-7).
  for (let intento = 0; intento < INTENTOS_INSERTAR; intento++) {
    const trabajo = await insertarTrabajo(
      tx,
      nuevo,
      intento === 0 ? { sinDuplicar: true } : undefined,
    );
    if (trabajo === "lleno") throw new ColaLlenaError();
    if (trabajo !== null) return { trabajo, nuevo: true };
    const existente = await trabajoVivoPorClave(tx, clave);
    if (existente !== null) return { trabajo: existente, nuevo: false };
  }
  // Cada intento chocó con un vivo que terminó antes de releerlo: no se insiste (500 sin datos).
  throw new Error("encolar: conflicto de dedupe persistente");
}

/** Intentos de INSERT ante choques de dedupe con vivos que terminan en ese instante (H-008-2b-7). */
const INTENTOS_INSERTAR = 3;

export interface TrabajoPublicable {
  id: string;
  tenantId: string;
  cola: NombreCola | string;
  prioridad: Prioridad | string;
  creadoEn: Date | string;
}

/** Lo que `publicar` necesita a partir del resultado de `encolar` (el estudio sale del contexto). */
export function aPublicable(
  tenantId: string,
  trabajo: TrabajoVista,
  prioridad: Prioridad,
): TrabajoPublicable {
  return {
    id: trabajo.id,
    tenantId,
    cola: definicionDe(trabajo.tipo).cola,
    prioridad,
    creadoEn: trabajo.creadoEn,
  };
}

/** Desplazamiento que deja cualquier programado detrás de todo interactivo (> cualquier epoch en ms). */
const DESPLAZAMIENTO_PROGRAMADO = 1e13;

const puntaje = (t: TrabajoPublicable): number =>
  (t.prioridad === "interactivo" ? 0 : DESPLAZAMIENTO_PROGRAMADO) +
  new Date(t.creadoEn).getTime();

/**
 * Pista en Redis tras el commit: ZADD pend:{cola}:{tenant} y SADD tenants:{cola}. Idempotente; los
 * errores de Redis se registran sin datos y no se propagan (el reconciliador repone).
 */
export async function publicar(
  redis: Pick<ClienteRedis, "zadd" | "sadd">,
  trabajos: readonly TrabajoPublicable[],
  opciones: { prefijo?: string } = {},
): Promise<void> {
  if (trabajos.length === 0) return;
  const k = crearClaves(opciones.prefijo);
  for (const t of trabajos) {
    try {
      await redis.zadd(k.pend(t.cola, t.tenantId), puntaje(t), t.id);
    } catch {
      registrarFallo(
        "publicar: fallo de Redis en la pista; el reconciliador repone",
      );
    }
    try {
      await redis.sadd(k.tenants(t.cola), t.tenantId);
    } catch {
      registrarFallo(
        "publicar: fallo de Redis en el conjunto; el reconciliador repone",
      );
    }
  }
}

/** Payload de BullMQ: exactamente { jobId, tenantId, tipo } (CA-15). */
export function payloadBullmq(
  t: Pick<TrabajoDespacho, "id" | "tenantId" | "tipo">,
): PayloadTrabajo {
  return { jobId: t.id, tenantId: t.tenantId, tipo: t.tipo };
}
