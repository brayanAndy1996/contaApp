// Ensamblado del worker de trabajos (spec 008, plan "Worker"): despachador (líder por cola), reconciliador, un Worker
// BullMQ por cola de `config_sistema` (concurrency = concurrencia global, ajustada en caliente, CA-4), el ejecutor y el
// worker de trabajos de sistema (`kek.rotar`, `auth.purgar` repetible a las 03:30 de Lima; D10, sin job_registro).
// `detener`: cierre ordenado (deja de despachar y de tomar trabajos, espera a los en curso hasta `esperaMs`, libera
// arriendos). `abortar`: muerte del proceso (kill -9): desde ese instante no escribe en la BD ni emite comandos por el
// Redis recibido, no libera arriendos y abandona lo que está en curso.
import type { KeyUnwrapper, KeyWrapper } from "@contapp/crypto/descifrado";
import { leerConfig, type ContappDb } from "@contapp/db";
import {
  CacheConfig,
  Despachador,
  LATIDO_MS,
  PREFIJO_POR_DEFECTO,
  Reconciliador,
  type NombreCola,
  type Reloj,
} from "@contapp/queue";
import {
  crearColas,
  crearColaSistema,
  crearWorkerSistema,
  crearWorkers,
  type ConexionBull,
  type PayloadSistema,
} from "@contapp/queue/worker";
import { MockSireAuth, type SireAuth } from "@contapp/sunat";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { crearServicioCredenciales } from "../credenciales/descifrar-credencial.js";
import { Ejecutor, type Procesador } from "./ejecutor.js";
import { dbGuardada, redisGuardado } from "./guardia.js";
import { authPurgar } from "./procesadores/auth-purgar.js";
import { kekRotar } from "./procesadores/kek-rotar.js";
import {
  loggerConsola,
  NotificadorLog,
  registrar,
  type LoggerTrabajos,
  type Notificador,
} from "./registro.js";
import {
  CacheTokenSire,
  type CredencialesSire,
} from "./token-sire/cache-token.js";
import { crearCredencialesSire } from "./token-sire/credenciales-sire.js";

export interface IntervalosTrabajos {
  despachadorMs?: number;
  reconciliadorMs?: number;
  latidoMs?: number;
}

export interface LlavesKek {
  activa: KeyUnwrapper & KeyWrapper;
  anterior(desde: string): KeyUnwrapper;
}

export interface DepsTrabajos {
  /** Rol contapp_worker (withTenant y withSistema). */
  db: ContappDb;
  redis: Redis;
  conexionBull: ConexionBull;
  prefijo?: string;
  reloj?: Reloj;
  /** Se suman a los por defecto (solo `prueba.eco` con NODE_ENV=test). */
  procesadores?: Record<string, Procesador>;
  notificador?: Notificador;
  sireAuth?: SireAuth;
  credencialesSire?: CredencialesSire;
  kek?: LlavesKek;
  logger?: LoggerTrabajos;
  proceso?: string;
  intervalos?: IntervalosTrabajos;
  /** Antigüedad mínima (s) que usa el reconciliador (por defecto 30). */
  antiguedadSeg?: number;
}

export interface TrabajosEnMarcha {
  detener(o?: { esperaMs?: number }): Promise<void>;
  abortar(): Promise<void>;
}

export const INTERVALOS_POR_DEFECTO: Required<IntervalosTrabajos> = {
  despachadorMs: 500,
  reconciliadorMs: 30_000,
  latidoMs: LATIDO_MS,
};
const ESPERA_CIERRE_MS = 30_000;
const ESPERA_ABORTO_MS = 2_000;

/** Procesador de `prueba.eco` (solo NODE_ENV=test): no hace nada y termina bien. */
const eco: Procesador = async () => ({ ok: true });

class SinCredencialesSireError extends Error {
  readonly codigo = "credenciales_sire_no_configuradas";
  constructor() {
    super("El worker no tiene cómo descifrar credenciales SIRE");
  }
}

interface Bucle {
  detener(): Promise<void>;
  abortar(): void;
}

/** Repite `paso` cada `ms` sin solaparse; nunca lanza. */
function bucle(paso: () => Promise<unknown>, ms: number): Bucle {
  let activo = true;
  let reloj: NodeJS.Timeout | undefined;
  let actual: Promise<unknown> | null = null;
  const vuelta = async () => {
    actual = paso().catch(() => undefined);
    await actual;
    actual = null;
    if (activo) reloj = setTimeout(() => void vuelta(), ms);
  };
  reloj = setTimeout(() => void vuelta(), 0);
  return {
    detener: async () => {
      activo = false;
      clearTimeout(reloj);
      await actual;
    },
    abortar: () => {
      activo = false;
      clearTimeout(reloj);
    },
  };
}

/** Cierra con tope de espera; nunca lanza. */
async function conTope(p: Promise<unknown>, ms: number): Promise<void> {
  let reloj: NodeJS.Timeout | undefined;
  await Promise.race([
    p.catch(() => undefined),
    new Promise((r) => (reloj = setTimeout(r, ms))),
  ]);
  clearTimeout(reloj);
}

export async function iniciarTrabajos(
  deps: DepsTrabajos,
): Promise<TrabajosEnMarcha> {
  const estado = { muerto: false, cerrando: false };
  const muerto = () => estado.muerto;
  const db = dbGuardada(deps.db, muerto);
  const redis = redisGuardado(deps.redis, muerto);
  const reloj: Reloj = deps.reloj ?? { ahora: () => new Date() };
  const prefijo = deps.prefijo ?? PREFIJO_POR_DEFECTO;
  const logger = deps.logger ?? loggerConsola;
  const intervalos = { ...INTERVALOS_POR_DEFECTO, ...deps.intervalos };
  const conexion = deps.conexionBull;

  // Las colas que existen son las de config_sistema (si no se puede leer, el worker no arranca).
  const inicial = await db.withSistema((tx) => leerConfig(tx));

  const credenciales: CredencialesSire =
    deps.credencialesSire ??
    (deps.kek
      ? crearCredencialesSire({
          db,
          servicio: crearServicioCredenciales({
            db,
            unwrapper: deps.kek.activa,
            logger: {
              log: (e) =>
                registrar(logger, "debug", {
                  evento: "credencial_descifrada",
                  credencial_id: e.credencialId,
                  resultado: e.resultado,
                }),
              warn: (e) =>
                registrar(logger, "warn", {
                  evento: "credencial_no_descifrada",
                  credencial_id: e.credencialId,
                  resultado: e.resultado,
                  codigo: e.codigo,
                }),
            },
          }),
        })
      : async () => {
          throw new SinCredencialesSireError();
        });
  const tokens = new CacheTokenSire({
    redis,
    sireAuth: deps.sireAuth ?? new MockSireAuth(),
    credenciales,
    reloj,
    prefijo,
    proceso: deps.proceso ?? randomUUID(),
  });
  const config = new CacheConfig(db, reloj);
  const ejecutor = new Ejecutor({
    db,
    redis,
    reloj,
    prefijo,
    procesadores: {
      ...(process.env.NODE_ENV === "test" ? { "prueba.eco": eco } : {}),
      ...deps.procesadores,
    },
    config,
    tokens,
    notificador: deps.notificador ?? new NotificadorLog(logger),
    logger,
    latidoMs: intervalos.latidoMs,
  });

  const colas = crearColas({ conexion, prefijo });
  const workers = crearWorkers({
    conexion,
    prefijo,
    colas: [...inicial].map(([cola, c]) => ({
      cola: cola as NombreCola,
      concurrencia: c.concurrenciaGlobal,
    })),
    procesar: (cola, payload) => ejecutor.ejecutar(cola, payload),
  });
  const despachador = new Despachador({
    db,
    redis,
    reloj,
    prefijo,
    agregarACola: (cola, p) => colas.agregarACola(cola, p),
  });
  const reconciliador = new Reconciliador({
    db,
    redis,
    reloj,
    prefijo,
    ...(deps.antiguedadSeg === undefined
      ? {}
      : { antiguedadSeg: deps.antiguedadSeg }),
  });

  const sistema = crearColaSistema({ conexion, prefijo });
  const procesarSistema = async (data: PayloadSistema): Promise<void> => {
    try {
      if (data.tipo === "auth.purgar") {
        await authPurgar({ db, reloj, logger });
      } else if (deps.kek === undefined) {
        registrar(logger, "error", {
          evento: "kek_rotar_sin_llaves",
          codigo: "kek_no_configurada",
        });
      } else {
        await kekRotar({
          db,
          activa: deps.kek.activa,
          anterior: deps.kek.anterior(data.desde),
          desde: data.desde,
          logger,
        });
      }
    } catch (e) {
      const codigo = (e as { codigo?: unknown } | null)?.codigo;
      registrar(logger, "error", {
        evento: "trabajo_sistema_fallo",
        trabajo: data.tipo,
        codigo: typeof codigo === "string" ? codigo : "desconocido",
      });
    }
  };
  const workerSistema = crearWorkerSistema({
    conexion,
    prefijo,
    procesar: procesarSistema,
  });
  await sistema.programarPurga();

  const bucleDespacho = bucle(async () => {
    await despachador.ciclo();
    // Concurrencia de BullMQ = concurrencia global vigente (CA-4).
    for (const [cola, c] of await config.obtener())
      workers.ajustarConcurrencia(cola, c.concurrenciaGlobal);
  }, intervalos.despachadorMs);
  const bucleReconciliacion = bucle(
    () => reconciliador.ciclo(),
    intervalos.reconciliadorMs,
  );
  registrar(logger, "info", { evento: "trabajos_iniciados" });

  const cerrarBull = (forzar: boolean) =>
    Promise.allSettled([
      workers.cerrar(forzar),
      workerSistema.cerrar(forzar),
      colas.cerrar(),
      sistema.cerrar(),
    ]);

  return {
    detener: async ({ esperaMs = ESPERA_CIERRE_MS } = {}) => {
      if (estado.cerrando || estado.muerto) return;
      estado.cerrando = true;
      // 1) No se despacha ni se reconcilia más; 2) BullMQ deja de tomar jobs; 3) se espera a los en curso.
      await Promise.all([
        bucleDespacho.detener(),
        bucleReconciliacion.detener(),
      ]);
      const cierre = cerrarBull(false);
      if (!(await ejecutor.esperar(esperaMs))) {
        // Tiempo agotado: se sueltan los arriendos de lo que sigue en curso (lo resuelve el reconciliador) y desde
        // aquí el proceso no escribe más.
        await ejecutor.soltarEnCurso();
        estado.muerto = true;
        await cerrarBull(true);
      }
      await conTope(cierre, esperaMs);
      registrar(logger, "info", { evento: "trabajos_detenidos" });
    },
    abortar: async () => {
      estado.muerto = true;
      estado.cerrando = true;
      bucleDespacho.abortar();
      bucleReconciliacion.abortar();
      ejecutor.abandonar();
      await conTope(cerrarBull(true), ESPERA_ABORTO_MS);
    },
  };
}
