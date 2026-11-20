import { uuidDe } from "./compras";

// Soporte de las pruebas del buzón SOL en el frontend (spec 023, T7): textos visibles, filas de ejemplo y rutas
// del backend. Son el contrato de T14 (`lib/buzon.ts` y `components/buzon/*`): las pantallas deben mostrar estos
// textos y llamar a estas rutas. Solo datos de prueba (canarios); sin lógica de producción. No importa tipos de
// `@contapp/shared` (los esquemas del buzón son un stub hasta T9).

export const CLIENTE_BUZON = "c-1";
export const MENSAJE_ID = uuidDe(23, 1);
export const ADJUNTO_ID = uuidDe(23, 2);

export const MENSAJES_BUZON = {
  // Botón «Revisar buzón ahora» (RevisarBuzon)
  revisar: "Revisar buzón ahora",
  encolada: "Revisión encolada.",
  enCurso: "Ya hay una revisión en curso.",
  enlacePanel: "Ver en el panel de trabajos",
  /** 429 `captura_reciente`: N = minutos enteros (hacia arriba, mínimo 1) hasta `revisarDesde`. */
  recienteEn: (n: number) =>
    `Se revisó hace poco. Podrás pedirlo de nuevo en ${n} min.`,
  archivado: "El cliente está archivado y es de solo lectura.",
  sinCredencial: "Primero guarda la clave SOL del cliente.",
  credencialInvalida:
    "La clave SOL fue rechazada por SUNAT. Actualízala para revisar el buzón.",
  // Lista
  listaVacia: "No hay mensajes en el buzón.",
  leidoEnSunat: "Leído en SUNAT",
  noLeidoEnSunat: "No leído en SUNAT",
  // Detalle
  abrirEnSunat: "Abrir en SUNAT",
  sinContenido: /aún no se obtuvo/i,
  avisoAbrir: /SUNAT puede marcar este mensaje como leído/,
  aperturaEncolada: "Apertura encolada.",
  yaObtenido: "El contenido ya se obtuvo.",
  confirmar: "Confirmar",
  cancelar: "Cancelar",
  omitido: {
    mime: "Tipo de archivo no permitido",
    tamano: "Supera los 20 MB",
    tope_mensaje: "Superó el tope de 50 MB del mensaje",
  },
  // Pantalla (textos propios; 024 los usa en la bandeja)
  cargarMas: "Cargar más",
  errorCarga: "No se pudo cargar el buzón. Inténtalo de nuevo.",
  // Notificación y panel de trabajos
  tipoRevisar: "Revisión de buzón SOL",
  tipoAbrir: "Apertura de mensaje SOL",
} as const;

/** Etiqueta en español de cada categoría (la misma en la lista, el detalle y la campana). */
export const ETIQUETA_CATEGORIA = {
  coactiva: "Coactiva",
  resolucion_determinacion: "Resolución de determinación",
  resolucion_multa: "Resolución de multa",
  requerimiento_fiscalizacion: "Requerimiento de fiscalización",
  otro: "Otro",
} as const;

export const rutaBuzon = (clienteId = CLIENTE_BUZON) =>
  `/api/clientes/${clienteId}/buzon`;
export const RUTA_REVISAR = `POST ${rutaBuzon()}/revisar`;
export const RUTA_MENSAJES = `GET ${rutaBuzon()}/mensajes`;
export const rutaDetalle = (id = MENSAJE_ID) =>
  `GET ${rutaBuzon()}/mensajes/${id}`;
export const rutaAbrir = (id = MENSAJE_ID) =>
  `POST ${rutaBuzon()}/mensajes/${id}/abrir`;
export const hrefAdjunto = (adjuntoId = ADJUNTO_ID, id = MENSAJE_ID) =>
  `${rutaBuzon()}/mensajes/${id}/adjuntos/${adjuntoId}`;

/** Fecha que en Lima es el 11/11 y en UTC el 12/11: sirve para probar que se muestra en hora de Lima. */
export const FECHA_NOCHE_LIMA = "2026-11-12T02:30:00.000Z";

export interface FilaBuzonPrueba {
  id: string;
  asunto: string;
  remitente: string;
  fecha: string;
  categoria: keyof typeof ETIQUETA_CATEGORIA;
  critico: boolean;
  motivoCritico: "codigo" | "asunto" | "duda" | null;
  leidoEnSunat: boolean;
  contenidoObtenido: boolean;
  adjuntosDeclarados: number;
  /** 024 (P-9): la fila de la bandeja lleva el cliente y la atención. */
  cliente: { id: string; razonSocial: string; archivado: boolean };
  atencion: {
    estado: "pendiente" | "atendido" | "historico";
    por: { id: string; nombre: string } | null;
    en: string | null;
  };
}

/**
 * `MensajeBuzonFila` del contrato HTTP (plan 023) con lo que 024 le suma (P-9): crítico de coactiva, sin leer y sin
 * contenido, pendiente de atención y del cliente `CLIENTE_BUZON`, por omisión. Esta forma sirve para pintar filas
 * directo en un componente; para una respuesta HTTP validada con `shared` (cliente con uuid) usa `filaBandeja`
 * de `pruebas/bandeja.ts`.
 */
export function filaBuzon(o: Partial<FilaBuzonPrueba> = {}): FilaBuzonPrueba {
  return {
    id: MENSAJE_ID,
    asunto: "Resolución Coactiva N° 0150140012345",
    remitente: "SUNAT - Notificaciones",
    fecha: FECHA_NOCHE_LIMA,
    categoria: "coactiva",
    critico: true,
    motivoCritico: "codigo",
    leidoEnSunat: false,
    contenidoObtenido: false,
    adjuntosDeclarados: 1,
    cliente: { id: CLIENTE_BUZON, razonSocial: "Alfa SAC", archivado: false },
    atencion: { estado: "pendiente", por: null, en: null },
    ...o,
  };
}

export interface AdjuntoPrueba {
  id: string;
  nombre: string;
  mime: string | null;
  tamano: number;
  omitido: "mime" | "tamano" | "tope_mensaje" | null;
}

export function adjuntoBuzon(o: Partial<AdjuntoPrueba> = {}): AdjuntoPrueba {
  return {
    id: ADJUNTO_ID,
    nombre: "resolucion.pdf",
    mime: "application/pdf",
    tamano: 20480,
    omitido: null,
    ...o,
  };
}

/** Evento del historial de atención (024). */
export interface EventoAtencionPrueba {
  accion: "atendido" | "deshecho";
  comentario: string | null;
  usuario: { id: string; nombre: string };
  en: string;
}

/** Atención del detalle (024): estado vigente, quién y cuándo, y el comentario vigente. */
export interface AtencionDetallePrueba {
  estado: "pendiente" | "atendido" | "historico";
  por: { id: string; nombre: string } | null;
  en: string | null;
  comentario: string | null;
}

/**
 * Cuerpo de `GET …/buzon/mensajes/:id` (`{mensaje, contenido, adjuntos, atencion, historial}`). Desde 024 (P-9) el
 * detalle trae `atencion` e `historial`; por omisión, pendiente y sin historial.
 */
export function detalleBuzon(
  o: {
    mensaje?: Partial<FilaBuzonPrueba>;
    contenido?: string | null;
    adjuntos?: AdjuntoPrueba[];
    atencion?: Partial<AtencionDetallePrueba>;
    historial?: EventoAtencionPrueba[];
  } = {},
) {
  return {
    mensaje: filaBuzon(o.mensaje),
    contenido: o.contenido === undefined ? null : o.contenido,
    adjuntos: o.adjuntos ?? [],
    atencion: { estado: "pendiente", por: null, en: null, comentario: null, ...o.atencion },
    historial: o.historial ?? [],
  };
}

/** Cuerpo de `GET …/buzon/mensajes` (`{estado, mensajes, siguiente}`). */
export function paginaBuzon(
  o: {
    mensajes?: FilaBuzonPrueba[];
    revisarDesde?: string | null;
    ultimaCaptura?: string | null;
  } = {},
) {
  return {
    estado: {
      ultimaCaptura: o.ultimaCaptura ?? "2026-11-17T12:00:00.000Z",
      sincronizado: true,
      revisarDesde: o.revisarDesde ?? null,
    },
    mensajes: o.mensajes ?? [],
    siguiente: null,
  };
}
