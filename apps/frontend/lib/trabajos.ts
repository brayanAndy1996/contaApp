import {
  resumenTrabajosSchema,
  trabajoVistaSchema,
  type ResumenTrabajos,
  type TrabajoVista,
} from "@contapp/shared";
import { api, type RespuestaApi } from "./api";
import { obtenerSesion } from "./sesion";

// Trabajos en segundo plano (spec 007b, D10). Listado, cancelación y lector del stream SSE de
// `/api/trabajos/stream`. Se usa `fetch` con lector de flujo (no `EventSource`) porque el stream
// necesita `X-Estudio`. Todo lo que llega se valida con el esquema de `shared`; no calcula negocio.

export type { ResumenTrabajos, TrabajoVista };

/** Espera inicial antes de reconectar; se duplica hasta `ESPERA_MAXIMA_MS` (que también acota el sondeo). */
export const ESPERA_INICIAL_MS = 1_000;
export const ESPERA_MAXIMA_MS = 10_000;
/** Una conexión que duró al menos esto se considera sana y reinicia la espera. */
const CONEXION_SANA_MS = 10_000;
/**
 * Tope de espera a que el stream quede conectado antes de listar. El servidor manda `: conectado` (y con él llegan
 * las cabeceras) cuando ya registró y suscribió la conexión; si tarda más que esto se lista igualmente.
 */
export const TOPE_ESPERA_STREAM_MS = 3_000;
/** Tope de texto sin completar un evento (un evento real mide < 1 KB). */
const TOPE_PENDIENTE = 256 * 1024;

/** Lista del estudio (solo lo que cumple el esquema). */
export async function listarTrabajos(): Promise<RespuestaApi<TrabajoVista[]>> {
  const r = await api<unknown>("/trabajos");
  if (!r.ok) return { ok: false, status: r.status, datos: null };
  const filas = Array.isArray(r.datos) ? (r.datos as unknown[]) : [];
  const datos: TrabajoVista[] = [];
  for (const fila of filas) {
    const p = trabajoVistaSchema.safeParse(fila);
    if (p.success) datos.push(p.data);
  }
  return { ok: true, status: r.status, datos };
}

/**
 * Conteo por tipo y estado de TODOS los trabajos del estudio (`GET /trabajos` trae solo los 100 más recientes), o
 * `null` si la ruta falla o responde algo inválido: el panel cuenta entonces con lo que trae el listado.
 */
export async function obtenerResumenTrabajos(): Promise<ResumenTrabajos | null> {
  try {
    const r = await api<unknown>("/trabajos/resumen");
    if (!r.ok) return null;
    const p = resumenTrabajosSchema.safeParse(r.datos);
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export const cancelarTrabajo = (
  id: string,
): Promise<RespuestaApi<TrabajoVista>> =>
  api<TrabajoVista>(`/trabajos/${encodeURIComponent(id)}/cancelar`, {
    method: "POST",
  });

/**
 * Convierte un evento SSE ya completo (sin la línea en blanco final) en un trabajo, o `null` si es un
 * comentario (`: latido`), de otro tipo, JSON roto o no cumple el esquema.
 */
export function trabajoDeMarco(marco: string): TrabajoVista | null {
  let evento = "message";
  const datos: string[] = [];
  for (const linea of marco.split("\n")) {
    if (linea === "" || linea.startsWith(":")) continue;
    const i = linea.indexOf(":");
    const campo = i === -1 ? linea : linea.slice(0, i);
    let valor = i === -1 ? "" : linea.slice(i + 1);
    if (valor.startsWith(" ")) valor = valor.slice(1);
    if (campo === "event") evento = valor;
    else if (campo === "data") datos.push(valor);
  }
  if (evento !== "trabajo" || datos.length === 0) return null;
  try {
    const p = trabajoVistaSchema.safeParse(JSON.parse(datos.join("\n")));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

/** Lee el cuerpo SSE hasta que termina (o falla) y entrega cada trabajo válido. */
export async function leerEventos(
  cuerpo: ReadableStream<Uint8Array>,
  alEvento: (t: TrabajoVista) => void,
): Promise<void> {
  const lector = cuerpo.getReader();
  const decodificador = new TextDecoder();
  let pendiente = "";
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) return;
      pendiente += decodificador
        .decode(value, { stream: true })
        .replace(/\r\n?/g, "\n");
      let corte = pendiente.indexOf("\n\n");
      while (corte !== -1) {
        const t = trabajoDeMarco(pendiente.slice(0, corte));
        pendiente = pendiente.slice(corte + 2);
        if (t) alEvento(t);
        corte = pendiente.indexOf("\n\n");
      }
      if (pendiente.length > TOPE_PENDIENTE) {
        throw new Error("evento demasiado grande");
      }
    }
  } finally {
    lector.cancel().catch(() => undefined);
  }
}

const dormir = (ms: number, senal: AbortSignal): Promise<void> =>
  new Promise((resolver) => {
    if (senal.aborted) return resolver();
    const alAbortar = () => {
      clearTimeout(t);
      resolver();
    };
    const t = setTimeout(() => {
      senal.removeEventListener("abort", alAbortar);
      resolver();
    }, ms);
    senal.addEventListener("abort", alAbortar, { once: true });
  });

/** Espera a `promesa` hasta `ms` o hasta que `senal` se aborte; no rechaza y no deja el temporizador vivo. */
const esperarConTope = (
  promesa: Promise<unknown>,
  ms: number,
  senal: AbortSignal,
): Promise<void> =>
  new Promise((resolver) => {
    if (senal.aborted) return resolver();
    const terminar = () => {
      clearTimeout(t);
      senal.removeEventListener("abort", terminar);
      resolver();
    };
    const t = setTimeout(terminar, ms);
    senal.addEventListener("abort", terminar, { once: true });
    void promesa.then(terminar, terminar);
  });

/** Descarta el stream abierto (resuelva cuando resuelva) sin leerlo. */
const cancelarCuerpo = (abierto: Promise<Response | null>): void => {
  void abierto.then((r) => r?.body?.cancel().catch(() => undefined));
};

/**
 * ¿Ve el usuario el botón «Cancelar» de un trabajo? Quien lo encoló, el Dueño y el Administrador (008 D9). Solo
 * oculta: el servidor decide (403/409).
 */
export const puedeCancelar = (
  rol: string | null | undefined,
  usuarioId: string | null | undefined,
  trabajo: Pick<TrabajoVista, "creadoPor">,
): boolean =>
  rol === "dueno" ||
  rol === "admin" ||
  (!!usuarioId && trabajo.creadoPor?.usuarioId === usuarioId);

export interface OpcionesSeguimiento {
  /** Estado completo traído por `GET /trabajos` (al abrir y tras cada reconexión; el stream no trae estado inicial). */
  alListar: (trabajos: TrabajoVista[]) => void;
  /** Conteo total por tipo y estado, traído junto con cada listado (los 100 del listado no bastan). */
  alResumen?: (resumen: ResumenTrabajos) => void;
  /** Un cambio de estado llegado por el stream. */
  alEvento: (trabajo: TrabajoVista) => void;
  /** `status` del último listado fallido, o `null` cuando volvió a funcionar. */
  alError: (status: number | null) => void;
  senal: AbortSignal;
}

/**
 * Sigue los trabajos hasta que `senal` se aborte: abre el stream y espera a que quede conectado (con tope), lista
 * y lo lee; al terminar (cierre normal a los 5 min o error) espera con espera creciente (1 s → 10 s) y repite,
 * re-sincronizando con el listado. Si el stream no se puede abrir, el propio ciclo sondea el listado al menos cada
 * 10 s. El stream no renueva la sesión (D22): aquí tampoco se trata como actividad. Un 401/403 del listado detiene
 * el ciclo.
 */
export async function seguirTrabajos(o: OpcionesSeguimiento): Promise<void> {
  const { senal } = o;
  let espera = ESPERA_INICIAL_MS;
  while (!senal.aborted) {
    const inicio = Date.now();
    let respuesta: Response | null = null;
    // D-7 (spec 020): el tope venció y se listó sin el stream; al abrirse, lo ocurrido entre ambos se relee una vez.
    let streamTardio = false;
    try {
      const sesion = await obtenerSesion();
      if (senal.aborted) return;
      let abierto: Promise<Response | null> = Promise.resolve(null);
      if (sesion) {
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
        };
        if (sesion.estudioActivo)
          headers["X-Estudio"] = sesion.estudioActivo.id;
        // Se abre y se espera antes de listar (T11e). El backend manda el primer byte `: conectado` solo cuando la
        // conexión ya está registrada y suscrita, y Next entrega las cabeceras con ese byte: al resolver `fetch`,
        // todo evento posterior queda en el flujo. Así lo ocurrido entre el listado y el registro del stream no se
        // pierde (el stream no trae estado inicial). La espera tiene tope (`TOPE_ESPERA_STREAM_MS`): con un stream
        // lento se lista igualmente y el stream se lee cuando llegue. Esto reemplaza al D-2 anterior (no esperar).
        abierto = fetch("/api/trabajos/stream", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers,
          signal: senal,
        }).catch(() => null);
        let abrio = false;
        void abierto.then(() => {
          abrio = true;
        });
        await esperarConTope(abierto, TOPE_ESPERA_STREAM_MS, senal);
        streamTardio = !abrio;
        if (senal.aborted) {
          cancelarCuerpo(abierto);
          return;
        }
      }
      const [lista, resumen] = await Promise.all([
        listarTrabajos(),
        obtenerResumenTrabajos(),
      ]);
      if (senal.aborted) {
        cancelarCuerpo(abierto);
        return;
      }
      if (lista.ok && lista.datos) {
        o.alError(null);
        o.alListar(lista.datos);
        if (resumen) o.alResumen?.(resumen);
      } else {
        o.alError(lista.status);
        if (lista.status === 401 || lista.status === 403) {
          cancelarCuerpo(abierto);
          return;
        }
      }
      respuesta = await abierto;
      if (senal.aborted) {
        void respuesta?.body?.cancel().catch(() => undefined);
        return;
      }
      if (streamTardio && respuesta?.ok && respuesta.body) {
        // Un trabajo pudo cambiar entre el listado y el registro del stream (que no trae estado inicial): una sola
        // lectura más, ya con el stream conectado. Si falla, el ciclo sigue con el listado anterior.
        const [nueva, nuevoResumen] = await Promise.all([
          listarTrabajos(),
          obtenerResumenTrabajos(),
        ]);
        if (senal.aborted) {
          void respuesta.body.cancel().catch(() => undefined);
          return;
        }
        if (nueva.ok && nueva.datos) {
          o.alListar(nueva.datos);
          if (nuevoResumen) o.alResumen?.(nuevoResumen);
        }
      }
      if (respuesta?.ok && respuesta.body) {
        await leerEventos(respuesta.body, o.alEvento);
      } else {
        void respuesta?.body?.cancel().catch(() => undefined);
      }
    } catch {
      // Red caída o abortada: se decide abajo.
    }
    if (senal.aborted) return;
    if (Date.now() - inicio >= CONEXION_SANA_MS) espera = ESPERA_INICIAL_MS;
    await dormir(espera, senal);
    espera = Math.min(espera * 2, ESPERA_MAXIMA_MS);
  }
}
