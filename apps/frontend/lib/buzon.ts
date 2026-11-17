import {
  abrirMensajeRespuestaSchema,
  detalleMensajeSchema,
  paginaMensajesBuzonSchema,
  revisarBuzonRespuestaSchema,
  type AbrirMensajeRespuesta,
  type CategoriaBuzon,
  type DetalleMensaje,
  type EstadoBuzon,
  type MensajeBuzonFila,
  type PaginaMensajesBuzon,
  type RevisarBuzonRespuesta,
} from "@contapp/shared";
import { api, type RespuestaApi } from "./api";

// Buzón SOL (spec 023, T14; plan, Contratos: Frontend). Cliente HTTP y textos de las pantallas del buzón de un
// cliente: botón «Revisar buzón ahora», lista y detalle de mensajes. Toda respuesta con cuerpo se valida con
// `@contapp/shared`; los errores 409 y 429 salen en español, nunca con el código. Sin cálculos de negocio: solo se
// convierte `revisarDesde` en minutos para el aviso de espera.

export type EstadoBuzonVista = EstadoBuzon;
export type { AbrirMensajeRespuesta, DetalleMensaje, MensajeBuzonFila, PaginaMensajesBuzon, RevisarBuzonRespuesta };

export const PERMISO_BUZON_VER = "buzon.ver";
export const PERMISO_BUZON_MARCAR_LEIDO = "buzon.marcar_leido";

export const MENSAJES_BUZON = {
  // Botón «Revisar buzón ahora»
  revisar: "Revisar buzón ahora",
  encolada: "Revisión encolada.",
  enCurso: "Ya hay una revisión en curso.",
  enlacePanel: "Ver en el panel de trabajos",
  /** 429 `captura_reciente`: N = minutos enteros (hacia arriba, mínimo 1) hasta `revisarDesde`. */
  recienteEn: (n: number) => `Se revisó hace poco. Podrás pedirlo de nuevo en ${n} min.`,
  archivado: "El cliente está archivado y es de solo lectura.",
  sinCredencial: "Primero guarda la clave SOL del cliente.",
  credencialInvalida: "La clave SOL fue rechazada por SUNAT. Actualízala para revisar el buzón.",
  // Lista
  listaVacia: "No hay mensajes en el buzón.",
  leidoEnSunat: "Leído en SUNAT",
  noLeidoEnSunat: "No leído en SUNAT",
  // Detalle
  abrirEnSunat: "Abrir en SUNAT",
  sinContenido: "El contenido aún no se obtuvo.",
  avisoAbrir:
    "Para obtener el contenido se abrirá el mensaje en el portal de SUNAT y SUNAT puede marcar este mensaje como leído. Esta acción no se deshace.",
  aperturaEncolada: "Apertura encolada.",
  yaObtenido: "El contenido ya se obtuvo.",
  confirmar: "Confirmar",
  cancelar: "Cancelar",
  omitido: {
    mime: "Tipo de archivo no permitido",
    tamano: "Supera los 20 MB",
    tope_mensaje: "Superó el tope de 50 MB del mensaje",
  },
  // Notificación y panel de trabajos
  tipoRevisar: "Revisión de buzón SOL",
  tipoAbrir: "Apertura de mensaje SOL",
  // Pantalla del buzón (textos propios de la página)
  titulo: "Buzón SOL",
  enlaceBuzon: "Buzón SOL",
  volverCliente: "Volver al cliente",
  volverLista: "Volver al buzón",
  cargando: "Cargando buzón…",
  cargandoMensaje: "Cargando mensaje…",
  cargarMas: "Cargar más",
  errorCarga: "No se pudo cargar el buzón. Inténtalo de nuevo.",
  ultimaCaptura: (fecha: string) => `Última revisión: ${fecha}`,
  nuncaRevisado: "Este buzón aún no se revisó.",
  tablaMensajes: "Mensajes del buzón SOL",
  columnas: { asunto: "Asunto", categoria: "Categoría", fecha: "Fecha", lectura: "Lectura en SUNAT" },
  remitente: "Remitente",
  adjuntos: "Adjuntos",
  tituloAbrir: "¿Abrir este mensaje en SUNAT?",
  critico: (categoria: string) => `Crítico · ${categoria}`,
} as const;

/** Etiqueta en español de cada categoría (la misma en la lista, el detalle y la campana). */
export const ETIQUETA_CATEGORIA: Record<CategoriaBuzon, string> = {
  coactiva: "Coactiva",
  resolucion_determinacion: "Resolución de determinación",
  resolucion_multa: "Resolución de multa",
  requerimiento_fiscalizacion: "Requerimiento de fiscalización",
  otro: "Otro",
};

/** Categoría en español; una que este cliente no conoce da «Otro», nunca el código crudo. */
export const etiquetaCategoria = (categoria: string): string =>
  (ETIQUETA_CATEGORIA as Record<string, string>)[categoria] ?? ETIQUETA_CATEGORIA.otro;

/** Texto del 409 de revisar/abrir (`cliente_archivado`, `credencial_*`); `null` si el código no es de buzón. */
export function textoConflictoBuzon(codigo: unknown): string | null {
  switch (codigo) {
    case "cliente_archivado":
      return MENSAJES_BUZON.archivado;
    case "credencial_no_configurada":
      return MENSAJES_BUZON.sinCredencial;
    case "credencial_invalida":
      return MENSAJES_BUZON.credencialInvalida;
    default:
      return null;
  }
}

/** Minutos enteros (hacia arriba, mínimo 1) desde `ahora` hasta `revisarDesde`; sin fecha o ya pasada, 1. */
export function minutosHasta(revisarDesde: string | null, ahora: number = Date.now()): number {
  if (!revisarDesde) return 1;
  const destino = Date.parse(revisarDesde);
  if (Number.isNaN(destino)) return 1;
  return Math.max(1, Math.ceil((destino - ahora) / 60_000));
}

const base = (clienteId: string): string => `/clientes/${encodeURIComponent(clienteId)}/buzon`;

/** Ruta de la vista del mensaje dentro de la app. */
export const hrefMensaje = (clienteId: string, mensajeId: string): string =>
  `/clientes/${encodeURIComponent(clienteId)}/buzon?mensaje=${encodeURIComponent(mensajeId)}`;

/** Ruta de descarga de un adjunto (el backend, por el rewrite de `/api`): siempre por id, nunca por nombre. */
export const hrefAdjunto = (clienteId: string, mensajeId: string, adjuntoId: string): string =>
  `/api${base(clienteId)}/mensajes/${encodeURIComponent(mensajeId)}/adjuntos/${encodeURIComponent(adjuntoId)}`;

function validar<T>(
  r: RespuestaApi<unknown>,
  esquema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
): RespuestaApi<T> {
  if (!r.ok) return { ok: false, status: r.status, datos: r.datos as T | null };
  const p = esquema.safeParse(r.datos);
  return p.success ? { ok: true, status: r.status, datos: p.data as T } : { ok: false, status: 500, datos: null };
}

export async function revisarBuzon(clienteId: string): Promise<RespuestaApi<RevisarBuzonRespuesta>> {
  const r = await api<unknown>(`${base(clienteId)}/revisar`, { method: "POST" });
  return validar(r, revisarBuzonRespuestaSchema);
}

export async function listarMensajes(
  clienteId: string,
  opciones: { cursor?: string | null; limite?: number } = {},
): Promise<RespuestaApi<PaginaMensajesBuzon>> {
  const q = new URLSearchParams();
  if (opciones.limite) q.set("limite", String(opciones.limite));
  if (opciones.cursor) q.set("cursor", opciones.cursor);
  const sufijo = q.size > 0 ? `?${q.toString()}` : "";
  return validar(await api<unknown>(`${base(clienteId)}/mensajes${sufijo}`), paginaMensajesBuzonSchema);
}

export async function obtenerMensaje(clienteId: string, mensajeId: string): Promise<RespuestaApi<DetalleMensaje>> {
  return validar(
    await api<unknown>(`${base(clienteId)}/mensajes/${encodeURIComponent(mensajeId)}`),
    detalleMensajeSchema,
  );
}

export async function abrirMensaje(clienteId: string, mensajeId: string): Promise<RespuestaApi<AbrirMensajeRespuesta>> {
  const r = await api<unknown>(`${base(clienteId)}/mensajes/${encodeURIComponent(mensajeId)}/abrir`, {
    method: "POST",
  });
  return validar(r, abrirMensajeRespuestaSchema);
}
