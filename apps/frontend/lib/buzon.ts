import {
  CATEGORIAS_BUZON,
  FILTROS_ATENCION,
  LOTE_MAX_ATENCION,
  abrirMensajeRespuestaSchema,
  detalleMensajeSchema,
  paginaMensajesBuzonSchema,
  respuestaBandejaSchema,
  respuestaLoteSchema,
  revisarBuzonRespuestaSchema,
  type AbrirMensajeRespuesta,
  type AtencionDetalle,
  type CategoriaBuzon,
  type DetalleMensaje,
  type EstadoAtencion,
  type EstadoBuzon,
  type EventoAtencion,
  type FilaBandeja,
  type FiltroAtencion,
  type MensajeBuzonFila,
  type PaginaMensajesBuzon,
  type RespuestaLote,
  type RevisarBuzonRespuesta,
} from "@contapp/shared";
import { mensajeDeError, MENSAJES } from "./acceso";
import { api, type RespuestaApi } from "./api";
import { obtenerSesion } from "./sesion";

// Buzón SOL (spec 023, T14; plan, Contratos: Frontend). Cliente HTTP y textos de las pantallas del buzón de un
// cliente: botón «Revisar buzón ahora», lista y detalle de mensajes. Toda respuesta con cuerpo se valida con
// `@contapp/shared`; los errores 409 y 429 salen en español, nunca con el código. Sin cálculos de negocio: solo se
// convierte `revisarDesde` en minutos para el aviso de espera.

export type EstadoBuzonVista = EstadoBuzon;
export type {
  AbrirMensajeRespuesta,
  AtencionDetalle,
  DetalleMensaje,
  EstadoAtencion,
  EventoAtencion,
  FilaBandeja,
  MensajeBuzonFila,
  PaginaMensajesBuzon,
  RespuestaLote,
  RevisarBuzonRespuesta,
};

/** La insignia «Crítico · <categoría>» puede partir línea: a 390 px no ensancha la tarjeta apilada (RNF-071). */
export const BADGE_PARTE_LINEA = "h-auto min-h-6 max-w-full whitespace-normal break-words py-0.5 text-left";

export const PERMISO_BUZON_VER = "buzon.ver";
export const PERMISO_BUZON_MARCAR_LEIDO = "buzon.marcar_leido";
export const PERMISO_BUZON_ATENDER = "buzon.atender";

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
  sinPermisoAbrir:
    "Para obtenerlo, una persona con permiso para abrir mensajes en SUNAT debe abrirlo desde esta pantalla.",
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

// Bandeja de buzones, atención e indicador (spec 024). Textos de las pantallas nuevas: se dicen con texto, no solo con color.
export const MENSAJES_BANDEJA = {
  tituloGlobal: "Buzones",
  chipPendientes: "Pendientes",
  chipCriticosPendientes: "Críticos pendientes",
  filtroAtencion: "Atención",
  filtroCategoria: "Categoría",
  filtroLeido: "Leído en SUNAT",
  filtroDesde: "Desde",
  filtroHasta: "Hasta",
  filtroCliente: "Cliente",
  filtroResponsable: "Solo donde soy responsable",
  filtroArchivados: "Incluir archivados",
  todosLosClientes: "Todos los clientes",
  abrirFiltros: "Filtros",
  aplicar: "Aplicar",
  limpiar: "Limpiar",
  tituloFiltros: "Filtros del buzón",
  descripcionFiltros: "Elige cómo filtrar los mensajes. Se aplican al pulsar «Aplicar».",
  fechasInvertidas: "La fecha «Desde» no puede ser posterior a «Hasta».",
  columnaCliente: "Cliente",
  columnaAtencion: "Atención",
  estado: { pendiente: "Pendiente", atendido: "Atendido", historico: "Histórico" },
  seleccionar: (asunto: string) => `Seleccionar ${asunto}`,
  volver: "Volver",
  marcar: "Marcar como atendido",
  deshacer: "Deshacer",
  comentario: "Comentario",
  contador: (n: number) => `${n}/500`,
  comentarioObligatorio: "El comentario es obligatorio para marcar un mensaje crítico.",
  conflicto: "Otra persona ya cambió este mensaje.",
  historial: "Historial de atención",
  accionAtendido: "Marcó como atendido",
  accionDeshecho: "Deshizo la atención",
  atendidoPor: (nombre: string) => `Atendido por ${nombre}`,
  tituloAtencion: "Atención del mensaje",
  marcarLote: "Marcar como atendidos",
  tituloLote: "Marcar como atendidos",
  descripcionLote: (n: number) =>
    n === 1 ? "Se marcará 1 mensaje como atendido." : `Se marcarán ${n} mensajes como atendidos.`,
  confirmar: "Confirmar",
  cancelar: "Cancelar",
  seleccionados: (n: number) => (n === 1 ? "1 seleccionado" : `${n} seleccionados`),
  maximoLote: `Máximo ${LOTE_MAX_ATENCION} mensajes por vez.`,
  resultadoLote: (atendidos: number, omitidos: number) =>
    `${atendidos} ${atendidos === 1 ? "atendido" : "atendidos"}, ${omitidos} ${
      omitidos === 1 ? "ya estaba atendido" : "ya estaban atendidos"
    }`,
  nuevos: (n: number) => (n === 1 ? "1 nuevo" : `${n} nuevos`),
  criticos: (n: number) => (n === 1 ? "1 crítico" : `${n} críticos`),
  filtroConMensajesNuevos: "Con mensajes nuevos",
  entradaMenu: "Buzones",
  nombreFiltros: "Filtros de la bandeja",
  atencionPor: (nombre: string) => `por ${nombre}`,
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

export type ResultadoDescargaAdjunto = { ok: true; archivo: Blob } | { ok: false; status: number; mensaje: string };

/**
 * Baja un adjunto (CA-8). Una navegación del navegador no manda `X-Estudio` y el servidor la rechaza con 409
 * `estudio_desfasado`; por eso se usa `fetch` con las cabeceras de la sesión (como el ZIP de archivos) y se entrega el
 * `Blob`. El error se traduce a un aviso en español: nunca se muestra el cuerpo de la respuesta.
 */
export async function descargarAdjuntoBuzon(
  clienteId: string,
  mensajeId: string,
  adjuntoId: string,
): Promise<ResultadoDescargaAdjunto> {
  try {
    const sesion = await obtenerSesion();
    if (!sesion) return { ok: false, status: 401, mensaje: MENSAJES.errorGeneral };
    const headers: Record<string, string> = {};
    if (sesion.estudioActivo) headers["X-Estudio"] = sesion.estudioActivo.id;
    const respuesta = await fetch(hrefAdjunto(clienteId, mensajeId, adjuntoId), {
      method: "GET",
      credentials: "same-origin",
      headers,
    });
    if (!respuesta.ok) {
      // 404 «no se encontró», 403 sin permiso, cualquier otro (409, 5xx) el aviso genérico.
      const status = respuesta.status === 403 || respuesta.status === 404 ? respuesta.status : 500;
      return { ok: false, status: respuesta.status, mensaje: mensajeDeError(status, null) };
    }
    return { ok: true, archivo: await respuesta.blob() };
  } catch {
    return { ok: false, status: 0, mensaje: MENSAJES.errorGeneral };
  }
}

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

// --- Filtros de la bandeja (D-2, D-3): viven en la URL con los mismos nombres que la API ---

export type FiltroCategoriaBandeja = "" | CategoriaBuzon | "criticos";

/** Valores de los filtros en la pantalla (texto de la URL ya validado). */
export interface ValoresFiltros {
  atencion: FiltroAtencion;
  categoria: FiltroCategoriaBandeja;
  leido: "" | "si" | "no";
  /** AAAA-MM-DD, día de Lima. */
  desde: string;
  hasta: string;
  responsable: boolean;
  archivados: boolean;
}

/** La bandeja abre en «Pendientes» (D-2). */
export const FILTROS_INICIALES: ValoresFiltros = {
  atencion: "pendientes",
  categoria: "",
  leido: "",
  desde: "",
  hasta: "",
  responsable: false,
  archivados: false,
};

/** Categorías que ofrece el filtro: «Críticos» (las cuatro críticas) y cada categoría. */
export const OPCIONES_CATEGORIA: readonly FiltroCategoriaBandeja[] = ["", "criticos", ...CATEGORIAS_BUZON];

const FECHA_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `AAAA-MM-DD` que existe en el calendario. */
export function esFechaDia(texto: string): boolean {
  const m = FECHA_DIA.exec(texto);
  if (!m) return false;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(a, mes - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === mes - 1 && f.getUTCDate() === d;
}

/**
 * Filtros desde la URL. Lo que no es un filtro válido (parámetro desconocido, valor inválido, `mensaje`, `cursor`) se
 * ignora: la API respondería 400. Con `fijada` (bandeja de un cliente) no existen `responsable` ni `archivados`.
 */
export function valoresDeParametros(
  params: { get(nombre: string): string | null },
  fijada: boolean,
): ValoresFiltros {
  const atencion = params.get("atencion");
  const categoria = params.get("categoria") ?? "";
  const leido = params.get("leido");
  let desde = params.get("desde") ?? "";
  let hasta = params.get("hasta") ?? "";
  if (!esFechaDia(desde)) desde = "";
  if (!esFechaDia(hasta)) hasta = "";
  if (desde && hasta && desde > hasta) desde = "";
  return {
    atencion: (FILTROS_ATENCION as readonly string[]).includes(atencion ?? "")
      ? (atencion as FiltroAtencion)
      : FILTROS_INICIALES.atencion,
    categoria: (OPCIONES_CATEGORIA as readonly string[]).includes(categoria)
      ? (categoria as FiltroCategoriaBandeja)
      : "",
    leido: leido === "si" || leido === "no" ? leido : "",
    desde,
    hasta,
    responsable: !fijada && params.get("responsable") === "yo",
    archivados: !fijada && params.get("archivados") === "1",
  };
}

/** Parámetros de la URL de la pantalla (siempre dice la atención; lo demás solo si no está vacío). */
export function parametrosDeValores(v: ValoresFiltros): URLSearchParams {
  const q = new URLSearchParams();
  q.set("atencion", v.atencion);
  if (v.categoria) q.set("categoria", v.categoria);
  if (v.leido) q.set("leido", v.leido);
  if (v.desde) q.set("desde", v.desde);
  if (v.hasta) q.set("hasta", v.hasta);
  if (v.responsable) q.set("responsable", "yo");
  if (v.archivados) q.set("archivados", "1");
  return q;
}

/** Ruta de la bandeja global o fijada en un cliente, con los filtros (sin `mensaje`). */
export function hrefBandeja(v: ValoresFiltros, clienteId: string | null, mensajeId?: string): string {
  const q = parametrosDeValores(
    clienteId ? { ...v, responsable: false, archivados: false } : v,
  );
  if (mensajeId) q.set("mensaje", mensajeId);
  const ruta = clienteId ? base(clienteId) : "/buzon";
  return `${ruta}?${q.toString()}`;
}

/** Página de la bandeja (global o de un cliente). `estado` solo viene en la ruta del cliente. */
export interface PaginaBandeja {
  mensajes: FilaBandeja[];
  siguiente: string | null;
  estado?: EstadoBuzon;
}

/** Lee una página: `GET /buzon/mensajes` o, con `clienteId`, `GET /clientes/:id/buzon/mensajes`. */
export async function listarBandeja(
  clienteId: string | null,
  v: ValoresFiltros,
  cursor: string | null,
): Promise<RespuestaApi<PaginaBandeja>> {
  const q = parametrosDeValores(v);
  if (clienteId) {
    q.delete("responsable");
    q.delete("archivados");
  }
  if (cursor) q.set("cursor", cursor);
  if (clienteId) {
    return validar<PaginaBandeja>(
      await api<unknown>(`${base(clienteId)}/mensajes?${q.toString()}`),
      paginaMensajesBuzonSchema,
    );
  }
  return validar<PaginaBandeja>(await api<unknown>(`/buzon/mensajes?${q.toString()}`), respuestaBandejaSchema);
}

// --- Atención (D-5 a D-8) ---

export type CuerpoAtencion = { accion: "marcar" | "deshacer"; comentario?: string };

/** `POST /clientes/:id/buzon/mensajes/:id/atencion`. El comentario va recortado y se omite si queda vacío. */
export function atenderMensaje(
  clienteId: string,
  mensajeId: string,
  accion: "marcar" | "deshacer",
  comentario: string,
): Promise<RespuestaApi<unknown>> {
  const texto = comentario.trim();
  const body: CuerpoAtencion = { accion, ...(texto ? { comentario: texto } : {}) };
  return api<unknown>(`${base(clienteId)}/mensajes/${encodeURIComponent(mensajeId)}/atencion`, {
    method: "POST",
    body,
  });
}

/** `POST /buzon/atencion` (lote, solo marca: U-3). */
export async function atenderLote(
  ids: string[],
  comentario: string,
): Promise<RespuestaApi<RespuestaLote>> {
  const texto = comentario.trim();
  const r = await api<unknown>("/buzon/atencion", {
    method: "POST",
    body: { mensajes: ids, ...(texto ? { comentario: texto } : {}) },
  });
  return validar(r, respuestaLoteSchema);
}

/** Texto en español de un error de la atención (400 y 409 de 024; el resto, el genérico de acceso). Nunca el código. */
export function textoErrorAtencion(status: number, datos: unknown): string {
  const codigo = (datos as { codigo?: string } | null)?.codigo;
  if (status === 409 && codigo === "atencion_cambiada") return MENSAJES_BANDEJA.conflicto;
  if (status === 409 && codigo === "cliente_archivado") return MENSAJES_BUZON.archivado;
  if (status === 400 && codigo === "comentario_requerido") return MENSAJES_BANDEJA.comentarioObligatorio;
  return mensajeDeError(status === 200 ? 500 : status, datos);
}

/** Estados de atención con su texto (la lista y el detalle). */
export const etiquetaAtencion = (estado: EstadoAtencion): string => MENSAJES_BANDEJA.estado[estado];

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
