// @contapp/queue/worker (spec 008): adaptador BullMQ, solo para apps/worker (el backend no lo importa).
// Las colas BullMQ solo transportan { jobId, tenantId, tipo } (CA-15); el estado vive en job_registro y
// los reintentos los decide el ejecutor (attempts: 1). Un job cuyo proceso murió nunca se reentrega
// (maxStalledCount: 0): lo recupera solo el reconciliador (CA-10; Ratificaciones de T5/T6 (6)).
// Trabajos de sistema (D10; Ratificaciones de T5/T6 (3)): cola `programados`, sin job_registro.
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { z } from "zod";
import {
  PREFIJO_POR_DEFECTO,
  registrarFallo,
  type AgregarACola,
  type NombreCola,
  type PayloadTrabajo,
} from "../tipos.js";

/** Payload aceptado por un worker: exactamente estas 3 claves; lo demás se descarta sin efectos. */
export const payloadTrabajoSchema = z
  .object({
    jobId: z.uuid(),
    tenantId: z.uuid(),
    tipo: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/),
  })
  .strict();

/** Prefijo de BullMQ derivado del de la app: "contapp:" -> "contapp:bull". */
export const prefijoBull = (prefijo: string = PREFIJO_POR_DEFECTO): string =>
  `${prefijo}bull`;

/** Opciones de conexión de BullMQ (el worker no depende de `bullmq`: usa este tipo). */
export type ConexionBull = ConnectionOptions;

export interface OpcionesColas {
  conexion: ConnectionOptions;
  prefijo?: string;
}

export interface ColasBull {
  agregarACola: AgregarACola;
  cerrar(): Promise<void>;
}

/**
 * Id del job de BullMQ de un despacho: el id del trabajo en el primer intento y `<id>-<intento>` en los siguientes
 * (H-008-1b-4). Con el mismo id, el `add` de un reintento se ignoraría mientras el job del intento anterior siga en
 * BullMQ (p. ej. activo sin lock tras un event loop bloqueado, hasta que la revisión de "stalled" lo saque) y el
 * trabajo quedaría `ejecutando` sin nadie que lo corra. El payload no cambia (CA-15); el job viejo nunca se reentrega
 * (`maxStalledCount: 0`) y el arriendo `ejec:` con la guarda de intentos impiden dos ejecuciones a la vez.
 */
export const idJobBull = (jobId: string, intento = 0): string =>
  intento > 0 ? `${jobId}-${intento}` : jobId;

/** Productor: una `Queue` por cola, creada al primer uso. `jobId` de BullMQ = `idJobBull(id, intento)`. */
export function crearColas(o: OpcionesColas): ColasBull {
  const colas = new Map<NombreCola, Queue>();
  const cola = (nombre: NombreCola): Queue => {
    let q = colas.get(nombre);
    if (q === undefined) {
      q = new Queue(nombre, {
        connection: o.conexion,
        prefix: prefijoBull(o.prefijo),
      });
      colas.set(nombre, q);
    }
    return q;
  };
  return {
    agregarACola: async (nombre, payload, opciones) => {
      await cola(nombre).add(
        payload.tipo,
        payloadTrabajoSchema.parse(payload),
        {
          jobId: idJobBull(payload.jobId, opciones?.intento),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    },
    cerrar: async () => {
      await Promise.all([...colas.values()].map((q) => q.close()));
      colas.clear();
    },
  };
}

export type Procesar = (
  cola: NombreCola,
  payload: PayloadTrabajo,
) => Promise<void>;

export interface OpcionesWorkers {
  conexion: ConnectionOptions;
  prefijo?: string;
  colas: readonly { cola: NombreCola; concurrencia: number }[];
  procesar: Procesar;
}

export interface WorkersBull {
  /** Ajusta la concurrencia en caliente (CA-4). */
  ajustarConcurrencia(cola: NombreCola, concurrencia: number): void;
  /** Cierra los workers; con `forzar` no espera a los jobs en curso (muerte simulada o tiempo agotado). */
  cerrar(forzar?: boolean): Promise<void>;
}

/** Procesa un job de BullMQ: payload inválido o forjado -> sin efectos (CA-15). */
export async function procesarJob(
  cola: NombreCola,
  job: Pick<Job, "data">,
  procesar: Procesar,
): Promise<void> {
  const r = payloadTrabajoSchema.safeParse(job.data);
  if (!r.success) {
    registrarFallo("worker: payload de trabajo inválido; se descarta");
    return;
  }
  await procesar(cola, r.data);
}

/**
 * Arriendo de BullMQ sobre el job activo y cadencia de su revisión de "stalled". Con un proceso muerto el job
 * huérfano sale de BullMQ (a `failed`, y se borra) en ≤ 10 s + 2 × 5 s, antes de que el reconciliador lo
 * vuelva a despachar con el mismo jobId (≥ 30 s): si siguiera ahí, BullMQ ignoraría el nuevo `add` (CA-10).
 */
export const ARRIENDO_BULL_MS = 10_000;
export const REVISION_STALLED_MS = 5_000;

/** Un error interno de BullMQ (conexión cerrada, etc.) se registra sin datos y no tumba el proceso. */
function escucharErrores(emisor: unknown, donde: string): void {
  const on = (emisor as { on?: (e: string, f: () => void) => unknown }).on;
  if (typeof on === "function") {
    on.call(emisor, "error", () => registrarFallo(donde));
  }
}

/** Un `Worker` de BullMQ por cola con `concurrency` = concurrencia global de la cola. */
export function crearWorkers(o: OpcionesWorkers): WorkersBull {
  const workers = new Map<NombreCola, Worker>();
  for (const { cola, concurrencia } of o.colas) {
    const w = new Worker(cola, (job) => procesarJob(cola, job, o.procesar), {
      connection: o.conexion,
      prefix: prefijoBull(o.prefijo),
      concurrency: Math.max(1, concurrencia),
      maxStalledCount: 0,
      lockDuration: ARRIENDO_BULL_MS,
      stalledInterval: REVISION_STALLED_MS,
    });
    escucharErrores(w, "worker: error interno de BullMQ");
    workers.set(cola, w);
  }
  return {
    ajustarConcurrencia: (cola, concurrencia) => {
      const w = workers.get(cola);
      if (w !== undefined) w.concurrency = Math.max(1, concurrencia);
    },
    cerrar: async (forzar = false) => {
      await Promise.all([...workers.values()].map((w) => w.close(forzar)));
      workers.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Trabajos de sistema (D10): `kek.rotar` (lo encola el operador) y `auth.purgar` (repetible diario).
// ---------------------------------------------------------------------------------------------------------------

export const COLA_SISTEMA = "programados" satisfies NombreCola;

/** Misma forma de kekId que 003 (`^[a-z0-9][a-z0-9-]{0,62}$`). */
const KEK_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Data de un job de sistema: unión discriminada estricta; lo demás se descarta sin efectos. */
export const payloadSistemaSchema = z.discriminatedUnion("tipo", [
  z
    .object({ tipo: z.literal("kek.rotar"), desde: z.string().regex(KEK_ID) })
    .strict(),
  z.object({ tipo: z.literal("auth.purgar") }).strict(),
]);
export type PayloadSistema = z.infer<typeof payloadSistemaSchema>;

/** Purga diaria a las 03:30 de Lima (CA-13). */
export const PURGA_PATRON = "30 3 * * *";
export const PURGA_TZ = "America/Lima";
const OPCIONES_JOB_SISTEMA = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
} as const;

export interface ColaSistema {
  /** Encola un job de sistema (nombre del job = tipo); data inválida lanza sin tocar Redis. */
  encolar(data: PayloadSistema): Promise<void>;
  /** Registra (idempotente) `auth.purgar` como repetible diario. */
  programarPurga(): Promise<void>;
  cerrar(): Promise<void>;
}

export function crearColaSistema(o: OpcionesColas): ColaSistema {
  let q: Queue | undefined;
  const cola = (): Queue =>
    (q ??= new Queue(COLA_SISTEMA, {
      connection: o.conexion,
      prefix: prefijoBull(o.prefijo),
    }));
  return {
    encolar: async (data) => {
      const d = payloadSistemaSchema.parse(data);
      await cola().add(d.tipo, d, OPCIONES_JOB_SISTEMA);
    },
    programarPurga: async () => {
      await cola().upsertJobScheduler(
        "auth.purgar",
        { pattern: PURGA_PATRON, tz: PURGA_TZ },
        {
          name: "auth.purgar",
          data: { tipo: "auth.purgar" },
          opts: OPCIONES_JOB_SISTEMA,
        },
      );
    },
    cerrar: async () => {
      await q?.close();
      q = undefined;
    },
  };
}

export interface OpcionesWorkerSistema {
  conexion: ConnectionOptions;
  prefijo?: string;
  procesar: (data: PayloadSistema) => Promise<void>;
}

export interface WorkerSistema {
  cerrar(forzar?: boolean): Promise<void>;
}

/** Procesa un job de sistema: data inválida o forjada -> sin efectos. */
export async function procesarJobSistema(
  job: Pick<Job, "data">,
  procesar: OpcionesWorkerSistema["procesar"],
): Promise<void> {
  const r = payloadSistemaSchema.safeParse(job.data);
  if (!r.success) {
    registrarFallo("worker: payload de sistema inválido; se descarta");
    return;
  }
  await procesar(r.data);
}

/** Worker de `programados` (concurrencia 1: los trabajos de sistema van de a uno). */
export function crearWorkerSistema(o: OpcionesWorkerSistema): WorkerSistema {
  const w = new Worker(
    COLA_SISTEMA,
    (job) => procesarJobSistema(job, o.procesar),
    {
      connection: o.conexion,
      prefix: prefijoBull(o.prefijo),
      concurrency: 1,
    },
  );
  escucharErrores(w, "worker: error interno de BullMQ (sistema)");
  return {
    cerrar: async (forzar = false) => {
      await w.close(forzar);
    },
  };
}
