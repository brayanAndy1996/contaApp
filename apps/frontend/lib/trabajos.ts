import { trabajoVistaSchema, type TrabajoVista } from "@contapp/shared";
import { api, type RespuestaApi } from "./api";
import { obtenerSesion } from "./sesion";

// Trabajos en segundo plano (spec 007b, D10). Listado, cancelación y lector del stream SSE de
// `/api/trabajos/stream`. Se usa `fetch` con lector de flujo (no `EventSource`) porque el stream
// necesita `X-Estudio`. Todo lo que llega se valida con el esquema de `shared`; no calcula negocio.

export type { TrabajoVista };

/** Espera inicial antes de reconectar; se duplica hasta `ESPERA_MAXIMA_MS` (que también acota el sondeo). */
export const ESPERA_INICIAL_MS = 1_000;
export const ESPERA_MAXIMA_MS = 10_000;
/** Una conexión que duró al menos esto se considera sana y reinicia la espera. */
const CONEXION_SANA_MS = 10_000;
/** Tope de texto sin completar un evento (un evento real mide < 1 KB). */
const TOPE_PENDIENTE = 256 * 1024;

/** Lista del estudio (solo lo que cumple el esquema). */
export async function listarTrabajos(): Promise<
  RespuestaApi<TrabajoVista[]>
> {
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

export interface OpcionesSeguimiento {
  /** Estado completo traído por `GET /trabajos` (al abrir y tras cada reconexión; el stream no trae estado inicial). */
  alListar: (trabajos: TrabajoVista[]) => void;
  /** Un cambio de estado llegado por el stream. */
  alEvento: (trabajo: TrabajoVista) => void;
  /** `status` del último listado fallido, o `null` cuando volvió a funcionar. */
  alError: (status: number | null) => void;
  senal: AbortSignal;
}

/**
 * Sigue los trabajos hasta que `senal` se aborte: lista, abre el stream y lo lee; al terminar (cierre normal a
 * los 5 min o error) espera con espera creciente (1 s → 10 s) y repite, re-sincronizando con el listado. Si el
 * stream no se puede abrir, el propio ciclo sondea el listado al menos cada 10 s. El stream no renueva la sesión
 * (D22): aquí tampoco se trata como actividad. Un 401/403 del listado detiene el ciclo.
 */
export async function seguirTrabajos(o: OpcionesSeguimiento): Promise<void> {
  const { senal } = o;
  let espera = ESPERA_INICIAL_MS;
  while (!senal.aborted) {
    const inicio = Date.now();
    let respuesta: Response | null = null;
    try {
      const sesion = await obtenerSesion();
      if (senal.aborted) return;
      if (sesion) {
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
        };
        if (sesion.estudioActivo) headers["X-Estudio"] = sesion.estudioActivo.id;
        // Se abre antes de listar: lo que ocurra durante el listado queda en el flujo y se lee después.
        respuesta = await fetch("/api/trabajos/stream", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers,
          signal: senal,
        }).catch(() => null);
      }
      const lista = await listarTrabajos();
      if (senal.aborted) {
        void respuesta?.body?.cancel().catch(() => undefined);
        return;
      }
      if (lista.ok && lista.datos) {
        o.alError(null);
        o.alListar(lista.datos);
      } else {
        o.alError(lista.status);
        if (lista.status === 401 || lista.status === 403) {
          void respuesta?.body?.cancel().catch(() => undefined);
          return;
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
