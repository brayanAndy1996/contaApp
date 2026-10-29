// Muerte simulada del proceso (`abortar`, CA-10): desde ese instante el worker no abre transacciones, no ejecuta
// consultas en las que ya estaban abiertas y no emite comandos por el Redis recibido. Todo lo que intente hacerlo
// recibe un rechazo (las transacciones abiertas hacen ROLLBACK, como con un `kill -9`), y nada llega a la BD ni a Redis.
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";

export class ProcesoDetenidoError extends Error {
  readonly codigo = "proceso_detenido";
  constructor() {
    super("El proceso de trabajos se detuvo");
    this.name = "ProcesoDetenidoError";
  }
}

const rechazo = (): Promise<never> =>
  Promise.reject(new ProcesoDetenidoError());

/** Redis que rechaza todo comando cuando `muerto()` es verdadero (sin emitirlo). */
export function redisGuardado(redis: Redis, muerto: () => boolean): Redis {
  return new Proxy(redis, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) =>
        muerto() ? rechazo() : Reflect.apply(v, target, args);
    },
  });
}

type Callback = (tx: {
  query: (...a: unknown[]) => Promise<unknown>;
}) => Promise<unknown>;

/** BD cuyas transacciones (withTenant/withSistema) no se abren ni consultan cuando `muerto()` es verdadero. */
export function dbGuardada<
  T extends Pick<ContappDb, "withTenant" | "withSistema">,
>(db: T, muerto: () => boolean): T {
  const envolverTx = (tx: Parameters<Callback>[0]) =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const v: unknown = Reflect.get(target, prop, receiver);
        if (prop !== "query" || typeof v !== "function") return v;
        return (...args: unknown[]) =>
          muerto() ? rechazo() : Reflect.apply(v, target, args);
      },
    });
  const envolver =
    (original: (...a: unknown[]) => Promise<unknown>) =>
    (...args: unknown[]) => {
      if (muerto()) return rechazo();
      const fn = args[args.length - 1] as Callback;
      return original(...args.slice(0, -1), (tx: Parameters<Callback>[0]) =>
        fn(envolverTx(tx)),
      );
    };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "withTenant" || prop === "withSistema") {
        const f = Reflect.get(target, prop, receiver) as (
          ...a: unknown[]
        ) => Promise<unknown>;
        return envolver(f.bind(target));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
