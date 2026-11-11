import {
  marcadasSchema,
  noLeidasSchema,
  notificacionSchema,
  TOPE_NO_LEIDAS,
  type Notificacion,
} from "@contapp/shared";
import { api, type RespuestaApi } from "./api";
import { obtenerSesion } from "./sesion";

// Notificaciones en la app (spec 017, D-10, D-11; CA-16). Cliente de las cuatro rutas de `/notificaciones` y lector
// del aviso en vivo (`event: notificacion` del stream de trabajos). Todo lo que llega se valida con los esquemas de
// `shared`; aquí no se calcula nada de negocio. Un `tipo` que este cliente no conoce no rompe la página: se muestra
// como notificación genérica (nunca el código crudo).

export type { Notificacion };

/** Notificación de un tipo que esta versión del frontend no conoce (el backend puede ir adelante). */
export interface NotificacionDesconocida {
  id: string;
  tipo: "desconocido";
  creadaEn: string;
  leidaEn: string | null;
  cliente: { id: string; razonSocial: string } | null;
  trabajoId: string | null;
}
export type NotificacionVista = Notificacion | NotificacionDesconocida;

export interface PaginaVista {
  items: NotificacionVista[];
  siguiente: string | null;
}

export const MENSAJES_NOTIFICACIONES = {
  titulo: "Notificaciones",
  campana: "Notificaciones",
  campanaConConteo: (n: string) => `Notificaciones, ${n} sin leer`,
  panel: "Panel de notificaciones",
  vacio: "No tienes notificaciones.",
  cargando: "Cargando notificaciones…",
  errorCarga: "No se pudieron cargar las notificaciones. Inténtalo de nuevo.",
  errorMarcar: "No se pudo marcar como leída. Inténtalo de nuevo.",
  reintentar: "Reintentar",
  marcarTodas: "Marcar todas como leídas",
  verTodas: "Ver todas",
  cargarMas: "Cargar más",
  sinLeer: "Sin leer",
  genericoTexto: "Tienes una notificación nueva.",
} as const;

/** Cuántas notificaciones enseña el panel de la campana. */
export const MAX_EN_PANEL = 10;

/** Evento de `window` para que la campana vuelva a leer el conteo tras marcar notificaciones. */
export const EVENTO_NOTIFICACIONES_CAMBIO = "contapp:notificaciones-cambio";

/** 100 es el tope del servidor: se muestra «99+». */
export function formatoConteo(n: number): string {
  return n >= TOPE_NO_LEIDAS ? "99+" : String(n);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);
const esFecha = (v: unknown): v is string =>
  typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Base común de cualquier notificación (sin `tipo` ni `params`), o `null` si no tiene esa forma. */
function baseDeFila(fila: unknown): Omit<NotificacionDesconocida, "tipo"> | null {
  if (typeof fila !== "object" || fila === null) return null;
  const f = fila as Record<string, unknown>;
  const c = f.cliente as Record<string, unknown> | null | undefined;
  const cliente =
    c && esUuid(c.id) && typeof c.razonSocial === "string"
      ? { id: c.id, razonSocial: c.razonSocial }
      : null;
  if (!esUuid(f.id) || !esFecha(f.creadaEn)) return null;
  if (f.leidaEn !== null && !esFecha(f.leidaEn)) return null;
  if (c != null && !cliente) return null;
  if (f.trabajoId != null && !esUuid(f.trabajoId)) return null;
  return {
    id: f.id,
    creadaEn: f.creadaEn,
    leidaEn: f.leidaEn,
    cliente,
    trabajoId: f.trabajoId ?? null,
  };
}

/** Valida una fila: conocida → tal cual; de otro tipo → genérica; sin forma de notificación → `null`. */
export function notificacionDeFila(fila: unknown): NotificacionVista | null {
  const conocida = notificacionSchema.safeParse(fila);
  if (conocida.success) return conocida.data;
  const base = baseDeFila(fila);
  return base ? { ...base, tipo: "desconocido" } : null;
}

export async function listarNotificaciones(
  cursor?: string | null,
): Promise<RespuestaApi<PaginaVista>> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const r = await api<unknown>(`/notificaciones${query}`);
  if (!r.ok) return { ok: false, status: r.status, datos: null };
  const cuerpo = (r.datos ?? {}) as { items?: unknown; siguiente?: unknown };
  const items: NotificacionVista[] = [];
  for (const fila of Array.isArray(cuerpo.items) ? cuerpo.items : []) {
    const n = notificacionDeFila(fila);
    if (n) items.push(n);
  }
  const siguiente =
    typeof cuerpo.siguiente === "string" ? cuerpo.siguiente : null;
  return { ok: true, status: r.status, datos: { items, siguiente } };
}

/** Conteo de no leídas (tope 100), o `null` si la ruta falla o responde algo inválido. */
export async function obtenerNoLeidas(): Promise<number | null> {
  try {
    const r = await api<unknown>("/notificaciones/no-leidas");
    if (!r.ok) return null;
    const p = noLeidasSchema.safeParse(r.datos);
    return p.success ? p.data.noLeidas : null;
  } catch {
    return null;
  }
}

export const marcarLeida = (id: string): Promise<RespuestaApi<null>> =>
  api<null>(`/notificaciones/${encodeURIComponent(id)}/leida`, {
    method: "POST",
  });

export async function marcarTodasLeidas(
  hasta: string,
): Promise<RespuestaApi<{ marcadas: number }>> {
  const r = await api<unknown>("/notificaciones/leidas", {
    method: "POST",
    body: { hasta },
  });
  if (!r.ok) return { ok: false, status: r.status, datos: null };
  const p = marcadasSchema.safeParse(r.datos);
  return { ok: p.success, status: r.status, datos: p.success ? p.data : null };
}

/** A dónde lleva una notificación: cliente → su ficha; trabajo → `/trabajos`; si no, a ningún lado. */
export function destinoDe(n: NotificacionVista): string | null {
  if (n.cliente) return `/clientes/${encodeURIComponent(n.cliente.id)}`;
  if (n.trabajoId) return "/trabajos";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Aviso en vivo
// ---------------------------------------------------------------------------------------------

/** ¿El marco SSE (sin la línea en blanco final) es `event: notificacion`? El aviso no trae contenido. */
export function avisoDeMarco(marco: string): boolean {
  for (const linea of marco.split("\n")) {
    if (linea.startsWith("event:")) {
      return linea.slice(6).trim() === "notificacion";
    }
  }
  return false;
}

const TOPE_PENDIENTE = 256 * 1024;

/** Lee el cuerpo SSE hasta que termina (o falla) y avisa por cada `event: notificacion`. */
export async function leerAvisos(
  cuerpo: ReadableStream<Uint8Array>,
  alAviso: () => void,
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
        const marco = pendiente.slice(0, corte);
        pendiente = pendiente.slice(corte + 2);
        if (avisoDeMarco(marco)) alAviso();
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

const ESPERA_INICIAL_MS = 1_000;
const ESPERA_MAXIMA_MS = 30_000;

const suscriptores = new Set<() => void>();
let controlador: AbortController | null = null;

async function cicloStream(senal: AbortSignal): Promise<void> {
  let espera = ESPERA_INICIAL_MS;
  while (!senal.aborted) {
    let detener = false;
    try {
      const sesion = await obtenerSesion();
      if (senal.aborted || !sesion) return;
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (sesion.estudioActivo) headers["X-Estudio"] = sesion.estudioActivo.id;
      const r = await fetch("/api/trabajos/stream", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        signal: senal,
      });
      if (r.status === 401 || r.status === 403) detener = true;
      else if (r.ok && r.body) {
        espera = ESPERA_INICIAL_MS;
        // Al (re)conectar se pone al día: lo avisado durante la desconexión no se pierde.
        suscriptores.forEach((cb) => cb());
        await leerAvisos(r.body, () => suscriptores.forEach((cb) => cb()));
      } else {
        void r.body?.cancel().catch(() => undefined);
      }
    } catch {
      // Red caída o abortada: se decide abajo.
    }
    if (detener || senal.aborted) return;
    await new Promise<void>((resolver) => {
      const t = setTimeout(resolver, espera);
      senal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolver();
        },
        { once: true },
      );
    });
    espera = Math.min(espera * 2, ESPERA_MAXIMA_MS);
  }
}

/**
 * Suscribe a los avisos de notificación. Hay UN solo stream por pestaña, compartido por todos los suscriptores:
 * se abre con el primero y se cierra al irse el último. `alAviso` corre en cada aviso y en cada reconexión.
 */
export function suscribirAvisos(alAviso: () => void): () => void {
  suscriptores.add(alAviso);
  if (!controlador) {
    controlador = new AbortController();
    void cicloStream(controlador.signal);
  }
  return () => {
    suscriptores.delete(alAviso);
    if (suscriptores.size === 0 && controlador) {
      controlador.abort();
      controlador = null;
    }
  };
}
