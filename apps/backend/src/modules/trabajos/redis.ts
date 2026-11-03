import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { Redis, type RedisOptions } from "ioredis";
import { crearClaves, type ClavesCola } from "@contapp/queue";

/** Redis de `/trabajos` (plan 008): `REDIS_URL` del entorno y el prefijo `contapp:` salvo que `crearApp` diga otro. */
export interface OpcionesRedisTrabajos {
  url: string;
  prefijo: string;
}

export const OPCIONES_REDIS = Symbol("TRABAJOS_OPCIONES_REDIS");
/** Fábrica de conexiones opcional (las pruebas unitarias inyectan dobles). */
export const CREAR_CONEXION = Symbol("TRABAJOS_CREAR_CONEXION");

/**
 * Con Redis caído nada espera más de ~1 s por comando: un reintento de conexión por comando, reconexión rápida y
 * `commandTimeout`. Conexión perezosa: no se abre ningún socket hasta el primer comando (arrancar no falla).
 */
const OPCIONES_CONEXION: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  commandTimeout: 1000,
  connectTimeout: 2000,
  retryStrategy: (intentos: number) => Math.min(intentos * 100, 1000),
};

/** Fábrica de conexiones (inyectable en las pruebas unitarias). */
export type CrearConexion = (url: string, o: RedisOptions) => Redis;

const conexionReal: CrearConexion = (url, o) => new Redis(url, o);

/**
 * Las dos conexiones Redis del proceso backend: una para publicar (pistas y eventos) y otra, en modo suscriptor,
 * para los eventos de `eventos:{tenantId}`. Se crean al primer uso y se cierran en orden al cerrar la app. Los errores
 * de conexión se descartan sin registrar nada (ni la URL, que puede llevar la clave de Redis).
 */
@Injectable()
export class RedisTrabajos implements OnApplicationShutdown {
  readonly prefijo: string;
  readonly claves: ClavesCola;
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  private cerrada = false;
  private readonly crear: CrearConexion;

  constructor(
    @Inject(OPCIONES_REDIS) private readonly opciones: OpcionesRedisTrabajos,
    @Optional() @Inject(CREAR_CONEXION) crear?: CrearConexion,
  ) {
    this.crear = crear ?? conexionReal;
    this.prefijo = opciones.prefijo;
    this.claves = crearClaves(opciones.prefijo);
  }

  private nueva(): Redis {
    const r = this.crear(this.opciones.url, OPCIONES_CONEXION);
    r.on("error", () => undefined);
    return r;
  }

  /** Conexión para ZADD/SADD/PUBLISH; `null` tras el cierre (lo que llegue tarde no abre otra conexión). */
  publicador(): Redis | null {
    if (this.cerrada) return null;
    this.pub ??= this.nueva();
    return this.pub;
  }

  /** Conexión en modo suscriptor (solo SUBSCRIBE/UNSUBSCRIBE y el evento `message`); `null` tras el cierre. */
  suscriptor(): Redis | null {
    if (this.cerrada) return null;
    this.sub ??= this.nueva();
    return this.sub;
  }

  /** Cierre ordenado: QUIT si la conexión está lista; si no, corta sin esperar (Redis caído no cuelga el cierre). */
  async cerrar(): Promise<void> {
    this.cerrada = true;
    const conexiones = [this.sub, this.pub].filter(
      (r): r is Redis => r !== null,
    );
    this.sub = null;
    this.pub = null;
    await Promise.all(conexiones.map(cerrarConexion));
  }

  onApplicationShutdown(): Promise<void> {
    return this.cerrar();
  }
}

async function cerrarConexion(r: Redis): Promise<void> {
  if (r.status === "ready") {
    try {
      await r.quit();
      return;
    } catch {
      // Cae al corte.
    }
  }
  r.disconnect();
}
