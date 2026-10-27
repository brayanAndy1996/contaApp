// @contapp/queue/worker (spec 008): adaptador BullMQ, solo para apps/worker (el backend no lo importa).
// Las colas BullMQ solo transportan { jobId, tenantId, tipo } (CA-15); el estado vive en job_registro y
// los reintentos los decide el ejecutor (attempts: 1).
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

export interface OpcionesColas {
  conexion: ConnectionOptions;
  prefijo?: string;
}

export interface ColasBull {
  agregarACola: AgregarACola;
  cerrar(): Promise<void>;
}

/** Productor: una `Queue` por cola, creada al primer uso. `jobId` de BullMQ = id del trabajo. */
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
    agregarACola: async (nombre, payload) => {
      await cola(nombre).add(
        payload.tipo,
        payloadTrabajoSchema.parse(payload),
        {
          jobId: payload.jobId,
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
  cerrar(): Promise<void>;
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

/** Un `Worker` de BullMQ por cola con `concurrency` = concurrencia global de la cola. */
export function crearWorkers(o: OpcionesWorkers): WorkersBull {
  const workers = new Map<NombreCola, Worker>();
  for (const { cola, concurrencia } of o.colas) {
    workers.set(
      cola,
      new Worker(cola, (job) => procesarJob(cola, job, o.procesar), {
        connection: o.conexion,
        prefix: prefijoBull(o.prefijo),
        concurrency: Math.max(1, concurrencia),
      }),
    );
  }
  return {
    ajustarConcurrencia: (cola, concurrencia) => {
      const w = workers.get(cola);
      if (w !== undefined) w.concurrency = Math.max(1, concurrencia);
    },
    cerrar: async () => {
      await Promise.all([...workers.values()].map((w) => w.close()));
      workers.clear();
    },
  };
}
