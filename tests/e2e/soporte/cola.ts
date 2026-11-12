// Retención del lock de RUC de la cola (spec 018, T11b). El despachador del worker no despacha un trabajo cuyo RUC
// tiene el lock tomado (spec 008, lock por canal y RUC): mientras la prueba lo retiene, el trabajo se queda «en cola»
// y la pantalla lo muestra así de forma determinista. Sin esto, el paso por «En cola» dura lo que tarde el siguiente
// ciclo del despachador (0 a 500 ms) y puede no llegar a pintarse. Toca solo la clave del lock, con un valor propio
// y un TTL corto: si la prueba muere sin soltarlo, Redis lo borra solo.
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { crearClaves } from "@contapp/queue";
import { Redis } from "ioredis";

/** Lo que dura el lock si nadie lo suelta. Cubre la espera de una aserción (5 s) con margen. */
const TTL_MS = 15_000;
/** Tope para tomar el lock: otra prueba con el mismo RUC puede tenerlo durante su trabajo (decenas de ms). */
const TOPE_TOMA_MS = 10_000;

/** Borra la clave solo si sigue siendo nuestra (no pisa un lock que el worker haya tomado después del TTL). */
const SOLTAR_SI_ES_NUESTRO = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;

export interface RetencionRuc {
  /** Suelta el lock; el siguiente ciclo del despachador toma el trabajo. Idempotente. */
  soltar(): Promise<void>;
}

/** Toma el lock del RUC en el canal (como el despachador, con `SET NX`) y lo retiene hasta `soltar()`. */
export async function retenerRuc(
  canal: "sire" | "sol",
  ruc: string,
): Promise<RetencionRuc> {
  const url = process.env.REDIS_URL;
  if (url === undefined) {
    throw new Error("Falta REDIS_URL (la fija el globalSetup).");
  }
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined);
  await redis.connect();
  const clave = crearClaves().lockRuc(canal, ruc);
  const valor = `e2e-${randomUUID()}`;
  try {
    await expect
      .poll(async () => redis.set(clave, valor, "PX", TTL_MS, "NX"), {
        message: "El lock del RUC no se liberó a tiempo",
        timeout: TOPE_TOMA_MS,
        intervals: [25, 50, 100],
      })
      .toBe("OK");
  } catch (error) {
    redis.disconnect();
    throw error;
  }
  let suelto = false;
  return {
    soltar: async () => {
      if (suelto) return;
      suelto = true;
      try {
        await redis.eval(SOLTAR_SI_ES_NUESTRO, 1, clave, valor);
      } finally {
        redis.disconnect();
      }
    },
  };
}
