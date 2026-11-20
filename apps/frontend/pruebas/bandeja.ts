import { vi } from "vitest";
import { yoDe } from "./acceso";
import {
  ETIQUETA_CATEGORIA,
  filaBuzon,
  detalleBuzon,
  type AtencionDetallePrueba,
  type EventoAtencionPrueba,
  type FilaBuzonPrueba,
} from "./buzon";
import { uuidDe } from "./compras";
import { sesionDe, type Manejador } from "./soporte";

// Soporte de las pruebas de la bandeja de buzones (spec 024, T5): textos visibles, filas, rutas y ayudas. Son el
// contrato de T9 (`lib/buzon.ts` y `components/buzon/*`): las pantallas deben mostrar estos textos y llamar a estas
// rutas. Solo datos de prueba (canarios); sin lógica de producción.

export const CLIENTE_A = uuidDe(24, 1);
export const CLIENTE_B = uuidDe(24, 2);
export const CLIENTE_ARCHIVADO = uuidDe(24, 3);
export const NOMBRE_A = "Alfa SAC";
export const NOMBRE_B = "Beta SRL";
export const NOMBRE_ARCHIVADO = "Zeta EIRL";

export const PERMISOS_VER = ["clientes.ver", "buzon.ver"];
export const PERMISOS_ATENDER = ["clientes.ver", "buzon.ver", "buzon.atender"];
/** Permisos del Contador de las pantallas de buzón: ve, abre, marca leído y atiende. */
export const PERMISOS_TODOS = ["clientes.ver", "buzon.ver", "buzon.marcar_leido", "buzon.atender"];

export const USUARIO_ANA = { id: uuidDe(24, 91), nombre: "Ana Prueba" };
export const USUARIO_LUIS = { id: uuidDe(24, 92), nombre: "Luis Contador" };

export const MENSAJES_BANDEJA = {
  // Pantalla
  tituloGlobal: "Buzones",
  // Filtros rápidos (botones con `aria-pressed`)
  chipPendientes: "Pendientes",
  chipCriticosPendientes: "Críticos pendientes",
  // Controles de filtro (etiquetas accesibles)
  filtroAtencion: "Atención",
  filtroCategoria: "Categoría",
  filtroLeido: "Leído en SUNAT",
  filtroDesde: "Desde",
  filtroHasta: "Hasta",
  filtroCliente: "Cliente",
  filtroResponsable: "Solo donde soy responsable",
  filtroArchivados: "Incluir archivados",
  todosLosClientes: "Todos los clientes",
  // Filtros a 390 px (Dialog)
  abrirFiltros: "Filtros",
  aplicar: "Aplicar",
  limpiar: "Limpiar",
  // Lista
  columnaCliente: "Cliente",
  columnaAtencion: "Atención",
  estado: { pendiente: "Pendiente", atendido: "Atendido", historico: "Histórico" },
  seleccionar: (asunto: string) => `Seleccionar ${asunto}`,
  volver: "Volver",
  // Atención de un mensaje
  marcar: "Marcar como atendido",
  deshacer: "Deshacer",
  comentario: "Comentario",
  contador: (n: number) => `${n}/500`,
  comentarioObligatorio: /comentario es obligatorio/i,
  conflicto: "Otra persona ya cambió este mensaje.",
  historial: "Historial de atención",
  accionAtendido: "Marcó como atendido",
  accionDeshecho: "Deshizo la atención",
  atendidoPor: (nombre: string) => `Atendido por ${nombre}`,
  // Lote
  marcarLote: "Marcar como atendidos",
  confirmar: "Confirmar",
  cancelar: "Cancelar",
  seleccionados: (n: number) => (n === 1 ? "1 seleccionado" : `${n} seleccionados`),
  maximoLote: /100/,
  // Indicador y filtro del listado de clientes
  nuevos: (n: number) => (n === 1 ? "1 nuevo" : `${n} nuevos`),
  criticos: (n: number) => (n === 1 ? "1 crítico" : `${n} críticos`),
  filtroConMensajesNuevos: "Con mensajes nuevos",
  // Menú
  entradaMenu: "Buzones",
} as const;

// --- rutas del backend (claves de `instalarFetchFalso`) ---
export const RUTA_BANDEJA = "GET /api/buzon/mensajes";
export const RUTA_LOTE = "POST /api/buzon/atencion";
export const RUTA_CLIENTES = "GET /api/clientes";
export const RUTA_YO = "GET /api/acceso/yo";
export const rutaMensajesDe = (clienteId: string) => `GET /api/clientes/${clienteId}/buzon/mensajes`;
export const rutaDetalleDe = (clienteId: string, mensajeId: string) =>
  `GET /api/clientes/${clienteId}/buzon/mensajes/${mensajeId}`;
export const rutaAtencionDe = (clienteId: string, mensajeId: string) =>
  `POST /api/clientes/${clienteId}/buzon/mensajes/${mensajeId}/atencion`;

/** Cliente de una fila de la bandeja (`FilaBandeja.cliente`). */
export const FILA_CLIENTE = {
  A: { id: CLIENTE_A, razonSocial: NOMBRE_A, archivado: false },
  B: { id: CLIENTE_B, razonSocial: NOMBRE_B, archivado: false },
  ARCHIVADO: { id: CLIENTE_ARCHIVADO, razonSocial: NOMBRE_ARCHIVADO, archivado: true },
} as const satisfies Record<string, FilaBuzonPrueba["cliente"]>;

/**
 * Fila de la respuesta de la bandeja (`FilaBandeja` de `shared`): como `filaBuzon` pero con el cliente con uuid (el
 * del cliente A por omisión), para que pase la validación de `shared`.
 */
export function filaBandeja(o: Partial<FilaBuzonPrueba> = {}): FilaBuzonPrueba {
  return filaBuzon({ cliente: { ...FILA_CLIENTE.A }, ...o });
}

/** Mensaje atendido por Ana el 18/11 (en Lima, 10:30). */
export const EN_ATENDIDO = "2026-11-18T15:30:00.000Z";
export const atendidaPor = (usuario = USUARIO_ANA): FilaBuzonPrueba["atencion"] => ({
  estado: "atendido",
  por: usuario,
  en: EN_ATENDIDO,
});

/** `n` filas distintas, todas pendientes, no críticas y del cliente A (para el tope del lote y la paginación). */
export function filasPendientes(n: number, prefijo = 240): FilaBuzonPrueba[] {
  return Array.from({ length: n }, (_, i) =>
    filaBandeja({
      id: uuidDe(prefijo, i + 1),
      asunto: `Comunicado ${i + 1}`,
      categoria: "otro",
      critico: false,
      motivoCritico: null,
    }),
  );
}

/** Cuerpo de `GET /buzon/mensajes` (`{mensajes, siguiente}`). */
export const paginaGlobal = (mensajes: FilaBuzonPrueba[], siguiente: string | null = null) => ({ mensajes, siguiente });

/** Cuerpo de `GET /clientes/:id/buzon/mensajes` (`{estado, mensajes, siguiente}`). */
export const paginaDeCliente = (mensajes: FilaBuzonPrueba[], siguiente: string | null = null) => ({
  estado: { ultimaCaptura: "2026-11-17T12:00:00.000Z", sincronizado: true, revisarDesde: null },
  mensajes,
  siguiente,
});

/** Detalle con atención (`detalleBuzon` de 023 ya trae `atencion` e `historial`). */
export const detalleConAtencion = (
  mensaje: Partial<FilaBuzonPrueba>,
  atencion: Partial<AtencionDetallePrueba> = {},
  historial: EventoAtencionPrueba[] = [],
  contenido: string | null = "Texto del mensaje.",
) => detalleBuzon({ mensaje, contenido, atencion, historial });

/** Rutas base de una pantalla de buzón: sesión, `acceso/yo` y lo demás que se pase. */
export function rutasBase(permisos: string[], extra: Record<string, Manejador> = {}): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }) },
    [RUTA_YO]: { status: 200, cuerpo: yoDe("contador", permisos) },
    [RUTA_CLIENTES]: {
      status: 200,
      cuerpo: [
        { id: CLIENTE_A, razonSocial: NOMBRE_A },
        { id: CLIENTE_B, razonSocial: NOMBRE_B },
      ],
    },
    ...extra,
  };
}

/**
 * Simula el ancho de la pantalla con `matchMedia` (jsdom no lo trae): en «movil» toda consulta `max-width` coincide y
 * ninguna `min-width`; en «escritorio», al revés. Se deshace con `vi.unstubAllGlobals()`.
 */
export function simularPantalla(tipo: "movil" | "escritorio"): void {
  vi.stubGlobal("matchMedia", (consulta: string) => ({
    matches: consulta.includes("max-width") ? tipo === "movil" : tipo === "escritorio",
    media: consulta,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

/** Parámetros de la query de una llamada (`Llamada.url`). */
export const queryDe = (url: string): Record<string, string> =>
  Object.fromEntries(new URL(url, "http://x").searchParams);

export { ETIQUETA_CATEGORIA };
