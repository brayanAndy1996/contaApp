import {
  LIMITE_MAX_LISTADO,
  accionCompraRespuestaSchema,
  calcularRespuestaSchema,
  deshacerRespuestaSchema,
  detalleCompraSchema,
  diferenciaComprasSchema,
  errorDuplicadoSchema,
  errorFilaCambiadaSchema,
  errorRequiereDatoSchema,
  errorVersionObsoletaSchema,
  estadoPeriodoRespuestaSchema,
  informeMasivaSchema,
  listadoComprasSchema,
  propuestaComprasSchema,
  resumenComprasSchema,
  type AccionCompraRespuesta,
  type AceptarSugerencia,
  type AgregarCompra,
  type CalcularCompra,
  type CalcularRespuesta,
  type ClasificarCompra,
  type CodigoRechazoMasiva,
  type CuadreCompra,
  type DescartarCompra,
  type DeshacerRespuesta,
  type DetalleCompra,
  type DiferenciaComprasDto,
  type EditarCompra,
  type EstadoPeriodoCompras,
  type EstadoPeriodoRespuesta,
  type ExcluirCompra,
  type FilaCompraVista,
  type HallazgoVista,
  type InformeDescarga,
  type InformeMasiva,
  type ListadoCompras,
  type MasivaAceptar,
  type MasivaClasificar,
  type MasivaExcluir,
  type MasivaRestaurar,
  type PropuestaComprasDto,
  type ReabrirPeriodo,
  type RestaurarCompra,
  type ResumenComprasVista,
  type VistaCompras,
} from "@contapp/shared";
import { MENSAJES } from "./acceso";
import { api } from "./api";
import { obtenerSesion } from "./sesion";

// Cliente HTTP y textos de la pantalla de compras (spec 015, D-2, D-4). Habla con las rutas de 014
// (`/clientes/:clienteId/periodos/:periodo/compras`). Toda respuesta se valida con el esquema de
// `@contapp/shared`: si no calza, error genérico y nada a medias. Los montos son SIEMPRE cadenas del
// servidor; aquí no se convierten, suman ni comparan (eso es de `montos-compras.ts`).

export type {
  AccionCompraRespuesta,
  AceptarSugerencia,
  AgregarCompra,
  CalcularCompra,
  CalcularRespuesta,
  ClasificarCompra,
  CodigoRechazoMasiva,
  CuadreCompra,
  DescartarCompra,
  DeshacerRespuesta,
  DetalleCompra,
  DiferenciaComprasDto,
  EditarCompra,
  EstadoPeriodoCompras,
  EstadoPeriodoRespuesta,
  ExcluirCompra,
  FilaCompraVista,
  HallazgoVista,
  InformeDescarga,
  InformeMasiva,
  ListadoCompras,
  PropuestaComprasDto,
  ReabrirPeriodo,
  RestaurarCompra,
  ResumenComprasVista,
  VistaCompras,
};

// ---------------------------------------------------------------------------------------------
// Textos (una sola fuente para las piezas, las pruebas y la revisión)
// ---------------------------------------------------------------------------------------------

export const MENSAJES_COMPRAS = {
  titulo: "Compras",
  subtitulo: "Registro de Compras Electrónico (RCE) del SIRE",
  etiquetaPeriodo: "Periodo (AAAAMM)",
  periodoInvalido: "Ingresa un periodo válido (AAAAMM).",
  enlaceCompras: "Compras",
  enlaceVentas: "Ventas",
  cargandoPantalla: "Cargando…",
  cargando: "Cargando…",
  cargandoMas: (cargadas: number) => `Cargando… ${cargadas} compras`,
  cargaCompleta: (n: number) => `${n} compras cargadas`,
  errorCarga: "No se pudieron cargar las compras.",
  sinCompras: "No hay compras en este periodo.",
  sinResultados: "Ninguna compra coincide con los filtros.",
  sinPermisoVer: "No tienes permiso para ver las compras de este cliente.",

  // Solo lectura (D-13): el motivo legible que viaja en `ContextoCompras.soloLectura`.
  soloLectura: {
    clienteArchivado: "El cliente está archivado: las compras son de solo lectura.",
    sinPermiso: "No tienes permiso para modificar las compras.",
    revisadoSinAprobar:
      "El periodo está revisado: solo quien puede aprobar y generar lo modifica.",
    generado: "El periodo ya está generado: reábrelo para modificarlo.",
  },

  // Estado del periodo (D-13, D-14).
  estado: {
    abierto: "Abierto",
    revisado: "Revisado",
    generado: "Generado",
  } satisfies Record<EstadoPeriodoCompras, string>,
  marcarRevisado: "Marcar como revisado",
  confirmarRevisado:
    "¿Marcar el periodo como revisado? Solo quien puede aprobar y generar podrá modificarlo después.",
  reabrir: "Reabrir",
  confirmarReabrir: (estado: "revisado" | "generado") =>
    `¿Reabrir el periodo ${estado === "generado" ? "generado" : "revisado"}? Volverá a quedar abierto para modificarlo.`,
  periodoRevisado: "Periodo marcado como revisado.",
  periodoReabierto: "Periodo reabierto.",
  estadoPor: (fecha: string) => `Marcado el ${fecha}`,

  // Descarga (D-12).
  descargar: "Descargar",
  reintentar: "Reintentar",
  enCola: (n: number) => `En cola · posición ${n}`,
  enColaSinPosicion: "En cola",
  ejecutando: "Descargando la propuesta…",
  descargaCancelada: "La descarga se canceló.",
  descargaFallida: "La descarga falló",
  resumenDescarga: (nuevas: number, distintas: number) =>
    `${nuevas} nuevas, ${distintas} distintas`,
  ultimaDescarga: (fecha: string) => `Última descarga: ${fecha}`,
  sinDescargas: "Aún no hay descargas de este periodo.",
  motivosTrabajo: {
    sunat_no_responde: "SUNAT no responde",
    credencial_invalida: "Credencial inválida",
    datos_invalidos: "Datos inválidos",
    portal_cambio: "El portal de SUNAT cambió",
    interrumpido: "Interrumpido",
    acceso_retirado: "Acceso retirado",
    cancelado_usuario: "Cancelado por el usuario",
    error_interno: "Error interno",
  },
  tituloDiferencias: "Diferencias de la última descarga",
  sinDiferencias: "La última descarga no trajo diferencias.",

  // Resumen (D-8).
  tituloResumen: "Resumen del periodo",
  periodoEntero: "Periodo entero",
  columnaOriginal: "Original del SIRE",
  columnaVigente: "Vigente",
  columnaDiferencia: "Diferencia",
  conIgv: "Con IGV",
  sinIgv: "Sin IGV",
  filasConIgv: (n: number) => `${n} compras con IGV`,
  filasSinIgv: (n: number) => `${n} compras sin IGV`,
  avisoSinConvertir: (n: number) =>
    `${n} compras en USD no se incluyen en el resumen: falta su tipo de cambio.`,
  casilleros: {
    biDg: "Base DG",
    igvDg: "IGV DG",
    biDgng: "Base DGNG",
    igvDgng: "IGV DGNG",
    biDng: "Base DNG",
    igvDng: "IGV DNG",
    noGravado: "No gravado",
    isc: "ISC",
    icbper: "ICBPER",
    otrosTributos: "Otros tributos",
    total: "Total",
  },

  // Exportar (D-17 de 014).
  exportar: "Exportar a Excel",
  exportando: "Exportando…",
  errorExportar: "No se pudo exportar el Excel.",

  // Grilla (D-5, P-5, P-8).
  tablaCompras: "Compras del periodo",
  columnas: {
    tipo: "Tipo",
    comprobante: "Comprobante",
    proveedor: "Proveedor",
    fecha: "Fecha",
    moneda: "Moneda",
    tipoCambio: "Tipo de cambio",
    destino: "Destino",
    acciones: "Acciones",
    seleccionar: "Seleccionar",
    lupa: "Ver comprobante",
  },
  lupaDeshabilitada: "Disponible con el detalle del comprobante (016)",
  seleccionarFila: (comprobante: string) => `Seleccionar ${comprobante}`,
  seleccionarTodasVisibles: "Seleccionar las compras visibles",
  grupoConIgv: "Con IGV",
  grupoSinIgv: "Sin IGV",
  grupoExcluidas: "Excluidas",
  proveedorNuevo: "Proveedor nuevo",
  conAlerta: "Con alerta",
  agregada: "Agregada",
  excluida: "Excluida",
  clasificada: "Clasificada",
  porClasificar: "Por clasificar",
  destinos: {
    DG: "DG",
    DGNG: "DGNG",
    DNG: "DNG",
    Mixta: "Mixta",
    "Sin base": "Sin base",
  },
  destinoAyuda:
    "Destino según las bases con monto: DG (gravado), DGNG (mixto) o DNG (no gravado).",

  // Filtros y selección (D-4, D-8).
  filtros: "Filtros",
  vistas: {
    con_igv: "Con IGV",
    sin_igv: "Sin IGV",
    excluidas: "Excluidas",
  } satisfies Record<VistaCompras, string>,
  filtroAlertas: "Con alertas",
  filtroProveedorNuevo: "Proveedor nuevo",
  buscar: "Buscar por RUC, razón social o serie-número",
  seleccionadas: (n: number) => `${n} seleccionadas`,
  seleccionarDelFiltro: (n: number) => `Seleccionar las ${n} del filtro`,
  seleccionarDelFiltroCargando:
    "Espera a que termine la carga para seleccionar todas las del filtro.",
  seleccionarDemasiadas: (tope: number) =>
    `Hay más de ${tope} compras en el filtro: filtra más para seleccionarlas.`,
  limpiarSeleccion: "Quitar selección",

  // Edición por fila (D-6, D-16).
  editar: "Editar",
  guardando: "Guardando…",
  filaGuardada: "Cambios guardados.",
  edicionCancelada: "Edición cancelada.",
  totalLocal: "Total",
  cuadreNoVerificado: "Cuadre no verificado",
  descuadre: "No cuadra",
  cuadra: "Cuadra",
  montoMasDeDosDecimales:
    "El monto admite como máximo 2 decimales: corrígelo para guardarlo.",
  versionObsoleta:
    "Otra persona cambió esta compra. Se recargó la fila: revisa y repite.",

  // Acciones por fila (D-7, D-10, D-11).
  clasificar: "Clasificar",
  clasificarComo: (destino: string) => `Clasificar como ${destino}`,
  aceptarSugerencia: "Aceptar sugerencia",
  aceptar: "Aceptar",
  aceptarSugerencias: "Aceptar sugerencias",
  excluir: "Excluir",
  restaurar: "Restaurar",
  descartar: "Descartar",
  historial: "Historial",
  confirmar: "Confirmar",
  cancelar: "Cancelar",
  guardar: "Guardar",
  cerrar: "Cerrar",
  motivoExclusion: "Motivo (opcional)",
  motivoMaximo: "El motivo admite hasta 200 caracteres en una sola línea.",
  confirmarExcluirAgregada:
    "Esta compra se agregó a mano: excluirla equivale a descartarla. ¿Continuar?",
  confirmarDescartar: (comprobante: string) =>
    `¿Descartar la compra ${comprobante} agregada a mano?`,
  compraClasificada: "Compra clasificada.",
  compraExcluida: "Compra excluida.",
  compraRestaurada: "Compra restaurada.",
  compraDescartada: "Compra descartada.",
  sugerenciaAceptada: "Sugerencia aceptada.",
  confirmarSugerencia: "Esta sugerencia pide tu confirmación antes de aplicarse.",
  pedirGravado: "Monto gravado (base con IGV)",
  pedirDestino: "Destino de la compra",
  hallazgos: {
    "R-ISC": "ISC en la base",
    "R-MIX": "Compra mixta",
    "R-RED": "Redondeo",
    "R-NEW": "Proveedor nuevo",
    "R-GP": "Glosa de gasto personal",
  },

  // Masivas, informe, deshacer y rehacer (D-8, D-9, P-4).
  barraMasiva: "Acciones sobre la selección",
  aceptarRed: "Aceptar R-RED",
  aceptarRedSinSugerencia:
    "Ninguna de las compras seleccionadas tiene una sugerencia R-RED para aceptar.",
  aplicadas: (n: number) => `${n} aplicadas`,
  rechazadas: (n: number) => `${n} rechazadas`,
  informeMasivo: "Resultado de la acción masiva",
  tablaRechazadas: "Compras rechazadas",
  columnaMotivo: "Motivo",
  rechazoMasiva: {
    version_obsoleta: "Otra persona la cambió; se recargó la fila.",
    requiere_dato: "Necesita un dato: acéptala fila por fila.",
    revisar_de_nuevo: "La sugerencia cambió: revísala.",
    fila_excluida: "Está excluida.",
    no_masiva: "Su sugerencia no se acepta en masa: acéptala fila por fila.",
    no_excluida: "No está excluida.",
    solicitud_invalida: "La solicitud no es válida para esta compra.",
    no_encontrada: "La compra ya no existe.",
  } satisfies Record<CodigoRechazoMasiva, string>,
  deshacer: "Deshacer",
  rehacer: "Rehacer",
  confirmarDeshacerAjeno:
    "Se deshará la última operación del periodo, aunque no la hayas hecho en esta pantalla. ¿Continuar?",
  confirmarRehacerAjeno:
    "Se rehará la última operación deshecha del periodo, aunque no la hayas hecho en esta pantalla. ¿Continuar?",
  deshecho: (n: number) => `Se deshizo la operación (${n} compras).`,
  rehecho: (n: number) => `Se rehízo la operación (${n} compras).`,
  filaCambiada: "Otra persona cambió estas filas",
  verFilas: "Ver filas",
  nadaQueDeshacer: "No hay nada que deshacer.",
  nadaQueRehacer: "No hay nada que rehacer.",

  // Agregar compra (D-11, P-7) e Historial (P-6).
  agregarCompra: "Agregar compra",
  formularioAgregar: "Agregar compra",
  agregar: "Agregar",
  subirXml: "Subir XML",
  subirXmlDeshabilitado: "Disponible con el detalle del comprobante (016)",
  compraAgregada: "Compra agregada.",
  datosInvalidos: "Revisa los datos de la compra.",
  tipoCambioObligatorio: "El tipo de cambio es obligatorio en USD.",
  yaExisteEnPropuesta: "Ya existe en la propuesta",
  ubicarExistente: "Ubicar la compra existente",
  campos: {
    tipo: "Tipo",
    serie: "Serie",
    numero: "Número",
    tipoDoc: "Tipo de documento del proveedor",
    documento: "Documento del proveedor",
    razonSocial: "Razón social",
    fecha: "Fecha de emisión",
    moneda: "Moneda",
    tipoCambio: "Tipo de cambio",
  },
  tituloHistorial: "Historial de la compra",
  valorOriginal: "Valor original del SIRE",
  valorVigente: "Valor vigente",
  versiones: "Versiones",
  versionPor: (n: number, usuario: string, fecha: string) =>
    `Versión ${n} · ${usuario} · ${fecha}`,
  accionesVersion: {
    original: "Original del SIRE",
    agregada: "Agregada a mano",
    clasificar: "Clasificada",
    editar: "Editada",
    sugerencia: "Sugerencia aceptada",
    excluir: "Excluida",
    restaurar: "Restaurada",
    deshacer: "Deshecha",
    rehacer: "Rehecha",
  },
  sinHallazgos: "Sin hallazgos.",

  // Errores por código del servidor (014). Nunca se muestra el código ni el cuerpo crudo.
  errores: {
    periodo_revisado:
      "El periodo está revisado: solo quien puede aprobar y generar lo modifica.",
    periodo_generado: "El periodo ya está generado: reábrelo para modificarlo.",
    cliente_archivado: "El cliente está archivado y es de solo lectura.",
    credencial_no_configurada:
      "Faltan las credenciales SOL o SIRE del cliente: configúralas para descargar.",
    version_obsoleta:
      "Otra persona cambió esta compra. Se recargó la fila: revisa y repite.",
    fila_excluida: "La compra está excluida: restáurala antes de modificarla.",
    no_excluida: "La compra no está excluida.",
    no_descartable: "Solo se pueden descartar las compras agregadas a mano.",
    duplicado: "Ya existe en la propuesta.",
    fila_cambiada: "Otra persona cambió estas filas: no se pudo completar.",
    nada_que_deshacer: "No hay nada que deshacer.",
    nada_que_rehacer: "No hay nada que rehacer.",
    revisar_de_nuevo: "La sugerencia cambió. Se recargó la fila: revísala.",
    requiere_dato: "La sugerencia necesita un dato adicional.",
    requiere_confirmacion: "La sugerencia pide confirmación.",
    estado_invalido: "El estado del periodo cambió. Se recargó la pantalla.",
    solicitud_invalida: "Revisa los datos: la solicitud no es válida.",
    resumen_fuera_de_rango:
      "No se pudo calcular el resumen: hay montos fuera de rango.",
    no_encontrada: MENSAJES.noEncontrado,
    no_encontrado: MENSAJES.noEncontrado,
    permiso_denegado: MENSAJES.sinPermiso,
    respuesta_invalida: MENSAJES.errorGeneral,
  } as Readonly<Record<string, string>>,
} as const;

const codigoDe = (datos: unknown): string => {
  const c = (datos as { codigo?: unknown } | null)?.codigo;
  return typeof c === "string" ? c : "";
};

/**
 * Mensaje visible de un error del backend, por código y, si el código no se conoce, por estado HTTP.
 * Nunca muestra el cuerpo de la respuesta ni el código.
 */
export function mensajeDeErrorCompras(status: number, datos: unknown): string {
  const porCodigo = MENSAJES_COMPRAS.errores[codigoDe(datos)];
  if (porCodigo !== undefined) return porCodigo;
  if (status === 403) return MENSAJES.sinPermiso;
  if (status === 404) return MENSAJES.noEncontrado;
  return MENSAJES.errorGeneral;
}

/** Texto legible de un rechazo de una masiva; un código desconocido da el genérico. */
export function mensajeDeRechazoMasivo(codigo: string): string {
  const textos: Readonly<Record<string, string>> = MENSAJES_COMPRAS.rechazoMasiva;
  return textos[codigo] ?? MENSAJES.errorGeneral;
}

// ---------------------------------------------------------------------------------------------
// Tipos que consumen las demás piezas (plan, «Contratos»)
// ---------------------------------------------------------------------------------------------

/** `AAAAMM` con mes 01 a 12. */
export const PERIODO_VALIDO = /^\d{4}(0[1-9]|1[0-2])$/;

export const PERMISO_VER = "clientes.ver";
export const PERMISO_DESCARGAR = "sire.descargar";
export const PERMISO_CLASIFICAR = "sire.clasificar";
export const PERMISO_APROBAR_GENERAR = "sire.aprobar_generar";

export interface PermisosCompras {
  ver: boolean;
  descargar: boolean;
  clasificar: boolean;
  aprobarGenerar: boolean;
}

/**
 * Lo que la página entrega a las piezas de acciones (se escriben en paralelo sin conocer la página).
 * `soloLectura` lleva el motivo legible; las piezas de escritura no se muestran o se deshabilitan con ese texto.
 */
export interface ContextoCompras {
  clienteId: string;
  periodo: string;
  permisos: PermisosCompras;
  estado: EstadoPeriodoCompras;
  soloLectura: string | null;
  recargarFila: (id: string) => Promise<void>;
  recargarFilas: (ids: string[]) => Promise<void>;
  recargarResumen: () => Promise<void>;
}

/** Filtros del listado tal como los elige el usuario. */
export interface FiltrosCompras {
  vista: VistaCompras;
  alertas: boolean;
  proveedorNuevo: boolean;
  q: string;
}

export const FILTROS_INICIALES: FiltrosCompras = {
  vista: "con_igv",
  alertas: false,
  proveedorNuevo: false,
  q: "",
};

/** Bloque de la carga por cursor (D-4) y tope de filas que admite una selección o una masiva. */
export const TAMANO_BLOQUE = 1000;
export const TOPE_SELECCION = LIMITE_MAX_LISTADO;
/** Guarda contra un servidor que repita el cursor: 20.000 filas de tope de descarga ÷ 1.000 con holgura. */
const MAX_BLOQUES = 100;

// ---------------------------------------------------------------------------------------------
// Resultado y validación de respuestas (D-2)
// ---------------------------------------------------------------------------------------------

export interface ErrorCompras {
  ok: false;
  status: number;
  /** Código del servidor, `""` si no hubo, o `"respuesta_invalida"` si la respuesta no cumplió el esquema. */
  codigo: string;
  mensaje: string;
  /** 409 `version_obsoleta`. */
  versionVigente?: number;
  /** 422 `requiere_dato`. */
  dato?: "gravado" | "destino";
  /** 409 `fila_cambiada`. */
  ids?: string[];
  /** 409 `duplicado`: la compra existente. */
  id?: string;
}

export type ResultadoCompras<T> =
  | { ok: true; status: number; datos: T }
  | ErrorCompras;

interface Esquema<T> {
  safeParse(valor: unknown): { success: boolean; data?: T };
}

function falla(status: number, datos: unknown): ErrorCompras {
  const error: ErrorCompras = {
    ok: false,
    status,
    codigo: codigoDe(datos),
    mensaje: mensajeDeErrorCompras(status, datos),
  };
  const obsoleta = errorVersionObsoletaSchema.safeParse(datos);
  if (obsoleta.success) error.versionVigente = obsoleta.data.versionVigente;
  const requiere = errorRequiereDatoSchema.safeParse(datos);
  if (requiere.success) error.dato = requiere.data.dato;
  const cambiada = errorFilaCambiadaSchema.safeParse(datos);
  if (cambiada.success) error.ids = cambiada.data.ids;
  const duplicado = errorDuplicadoSchema.safeParse(datos);
  if (duplicado.success) error.id = duplicado.data.id;
  return error;
}

const respuestaInvalida = (status: number): ErrorCompras => ({
  ok: false,
  status,
  codigo: "respuesta_invalida",
  mensaje: MENSAJES.errorGeneral,
});

async function pedir<T>(
  ruta: string,
  esquema: Esquema<T>,
  opciones: { method?: string; body?: unknown } = {},
): Promise<ResultadoCompras<T>> {
  let r;
  try {
    r = await api<unknown>(ruta, opciones);
  } catch {
    return respuestaInvalida(0);
  }
  if (!r.ok) return falla(r.status, r.datos);
  const analizado = esquema.safeParse(r.datos);
  if (!analizado.success || analizado.data === undefined) {
    return respuestaInvalida(r.status);
  }
  return { ok: true, status: r.status, datos: analizado.data };
}

const esquemaTrabajo: Esquema<{ trabajoId: string }> = {
  safeParse(valor) {
    const id = (valor as { trabajoId?: unknown } | null)?.trabajoId;
    return typeof id === "string" && id !== ""
      ? { success: true, data: { trabajoId: id } }
      : { success: false };
  },
};

const esquemaPropuestas: Esquema<PropuestaComprasDto[]> = {
  safeParse(valor) {
    if (!Array.isArray(valor)) return { success: false };
    const datos: PropuestaComprasDto[] = [];
    for (const elemento of valor as unknown[]) {
      const p = propuestaComprasSchema.safeParse(elemento);
      if (!p.success) return { success: false };
      datos.push(p.data);
    }
    return { success: true, data: datos };
  },
};

const esquemaDiferencias: Esquema<DiferenciaComprasDto[]> = {
  safeParse(valor) {
    if (!Array.isArray(valor)) return { success: false };
    const datos: DiferenciaComprasDto[] = [];
    for (const elemento of valor as unknown[]) {
      const p = diferenciaComprasSchema.safeParse(elemento);
      if (!p.success) return { success: false };
      datos.push(p.data);
    }
    return { success: true, data: datos };
  },
};

// ---------------------------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------------------------

const base = (clienteId: string, periodo: string): string =>
  `/clientes/${encodeURIComponent(clienteId)}/periodos/${encodeURIComponent(periodo)}/compras`;

const rutaDe = (clienteId: string, periodo: string, compraId: string): string =>
  `${base(clienteId, periodo)}/${encodeURIComponent(compraId)}`;

/** Query del listado: solo manda lo que tiene valor; los textos viajan codificados por `URLSearchParams`. */
export function consultaDeListado(
  filtros: FiltrosCompras,
  cursor?: string,
  limite: number = TAMANO_BLOQUE,
): string {
  const q = new URLSearchParams();
  q.set("limite", String(limite));
  q.set("vista", filtros.vista);
  if (filtros.alertas) q.set("alertas", "true");
  if (filtros.proveedorNuevo) q.set("proveedorNuevo", "true");
  const busqueda = filtros.q.trim();
  if (busqueda !== "") q.set("q", busqueda);
  if (cursor !== undefined) q.set("cursor", cursor);
  return q.toString();
}

// ---------------------------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------------------------

export const listarCompras = (
  clienteId: string,
  periodo: string,
  filtros: FiltrosCompras,
  cursor?: string,
  limite: number = TAMANO_BLOQUE,
): Promise<ResultadoCompras<ListadoCompras>> =>
  pedir(
    `${base(clienteId, periodo)}?${consultaDeListado(filtros, cursor, limite)}`,
    listadoComprasSchema,
  );

export interface OpcionesCarga {
  /** Al abortarla no se piden más bloques y lo que llegue después se descarta. */
  senal: AbortSignal;
  /** Cada bloque validado, en orden, solo mientras la carga siga vigente. */
  alBloque: (
    bloque: FilaCompraVista[],
    info: { primero: boolean; ultimo: boolean },
  ) => void;
  tamanoBloque?: number;
}

export type ResultadoCarga =
  | { estado: "completa"; filas: number }
  | { estado: "cancelada" }
  | { estado: "error"; error: ErrorCompras };

/**
 * Carga el periodo por cursor en bloques de 1.000 hasta que `siguiente` sea `null` (D-4). La grilla puede usar
 * el primer bloque mientras llegan los demás. Cancelar (`senal`) detiene la carga y descarta la respuesta que
 * estuviera en vuelo: una respuesta vieja nunca llega a `alBloque`. Un bloque inválido o un cursor repetido
 * terminan en error sin pintar nada a medias; los bloques ya entregados siguen siendo válidos.
 */
export async function cargarPeriodo(
  clienteId: string,
  periodo: string,
  filtros: FiltrosCompras,
  o: OpcionesCarga,
): Promise<ResultadoCarga> {
  const tamano = o.tamanoBloque ?? TAMANO_BLOQUE;
  const cursores = new Set<string>();
  let cursor: string | undefined;
  let filas = 0;
  let bloques = 0;
  for (;;) {
    if (o.senal.aborted) return { estado: "cancelada" };
    const r = await listarCompras(clienteId, periodo, filtros, cursor, tamano);
    if (o.senal.aborted) return { estado: "cancelada" };
    if (!r.ok) return { estado: "error", error: r };
    bloques += 1;
    filas += r.datos.filas.length;
    const siguiente = r.datos.siguiente;
    o.alBloque(r.datos.filas, { primero: bloques === 1, ultimo: siguiente === null });
    if (siguiente === null) return { estado: "completa", filas };
    if (cursores.has(siguiente) || bloques >= MAX_BLOQUES) {
      return { estado: "error", error: respuestaInvalida(r.status) };
    }
    cursores.add(siguiente);
    cursor = siguiente;
  }
}

export const obtenerResumenCompras = (
  clienteId: string,
  periodo: string,
): Promise<ResultadoCompras<ResumenComprasVista>> =>
  pedir(`${base(clienteId, periodo)}/resumen`, resumenComprasSchema);

export const listarPropuestasCompras = (
  clienteId: string,
  periodo: string,
): Promise<ResultadoCompras<PropuestaComprasDto[]>> =>
  pedir(`${base(clienteId, periodo)}/propuestas`, esquemaPropuestas);

export const listarDiferenciasCompras = (
  clienteId: string,
  periodo: string,
  propuestaId: string,
): Promise<ResultadoCompras<DiferenciaComprasDto[]>> =>
  pedir(
    `${base(clienteId, periodo)}/propuestas/${encodeURIComponent(propuestaId)}/diferencias`,
    esquemaDiferencias,
  );

export const obtenerDetalleCompra = (
  clienteId: string,
  periodo: string,
  compraId: string,
): Promise<ResultadoCompras<DetalleCompra>> =>
  pedir(rutaDe(clienteId, periodo, compraId), detalleCompraSchema);

/** Encola la descarga: 202 `{trabajoId}`. */
export const descargarCompras = (
  clienteId: string,
  periodo: string,
): Promise<ResultadoCompras<{ trabajoId: string }>> =>
  pedir(`${base(clienteId, periodo)}/descargar`, esquemaTrabajo, {
    method: "POST",
  });

export type ResultadoExportacion =
  | { ok: true; status: number; archivo: Blob; nombre: string }
  | ErrorCompras;

/**
 * Excel del periodo. `api()` solo lee JSON, así que esta ruta usa `fetch` con las mismas cabeceras de sesión
 * (`X-Estudio`) y entrega el archivo como `Blob` para que la pantalla lo guarde; nunca interpreta su contenido.
 */
export async function exportarCompras(
  clienteId: string,
  periodo: string,
): Promise<ResultadoExportacion> {
  try {
    const sesion = await obtenerSesion();
    if (!sesion) return falla(401, null);
    const headers: Record<string, string> = {};
    if (sesion.estudioActivo) headers["X-Estudio"] = sesion.estudioActivo.id;
    const respuesta = await fetch(`/api${base(clienteId, periodo)}/exportar.xlsx`, {
      method: "GET",
      credentials: "same-origin",
      headers,
    });
    if (!respuesta.ok) {
      let cuerpo: unknown = null;
      try {
        cuerpo = JSON.parse(await respuesta.text()) as unknown;
      } catch {
        cuerpo = null;
      }
      return falla(respuesta.status, cuerpo);
    }
    const archivo = await respuesta.blob();
    const disposicion = respuesta.headers.get("content-disposition") ?? "";
    const nombre =
      /filename="([A-Za-z0-9._-]{1,100})"/.exec(disposicion)?.[1] ??
      `compras-${periodo}.xlsx`;
    return { ok: true, status: respuesta.status, archivo, nombre };
  } catch {
    return respuestaInvalida(0);
  }
}

// ---------------------------------------------------------------------------------------------
// Escrituras por fila
// ---------------------------------------------------------------------------------------------

const accion = (
  clienteId: string,
  periodo: string,
  compraId: string,
  sufijo: string,
  body: unknown,
): Promise<ResultadoCompras<AccionCompraRespuesta>> =>
  pedir(`${rutaDe(clienteId, periodo, compraId)}/${sufijo}`, accionCompraRespuestaSchema, {
    method: "POST",
    body,
  });

export const clasificarCompra = (
  clienteId: string,
  periodo: string,
  compraId: string,
  datos: ClasificarCompra,
) => accion(clienteId, periodo, compraId, "clasificar", datos);

export const editarCompra = (
  clienteId: string,
  periodo: string,
  compraId: string,
  datos: EditarCompra,
) => accion(clienteId, periodo, compraId, "editar", datos);

export const aceptarSugerenciaCompra = (
  clienteId: string,
  periodo: string,
  compraId: string,
  datos: AceptarSugerencia,
) => accion(clienteId, periodo, compraId, "sugerencias/aceptar", datos);

export const excluirCompra = (
  clienteId: string,
  periodo: string,
  compraId: string,
  datos: ExcluirCompra,
) => accion(clienteId, periodo, compraId, "excluir", datos);

export const restaurarCompra = (
  clienteId: string,
  periodo: string,
  compraId: string,
  datos: RestaurarCompra,
) => accion(clienteId, periodo, compraId, "restaurar", datos);

export const descartarCompra = (
  clienteId: string,
  periodo: string,
  compraId: string,
  datos: DescartarCompra,
) => accion(clienteId, periodo, compraId, "descartar", datos);

/** Vista previa del total y del cuadre mientras se teclea (D-16): no escribe nada. */
export const calcularCompra = (
  clienteId: string,
  periodo: string,
  compraId: string,
  datos: CalcularCompra,
): Promise<ResultadoCompras<CalcularRespuesta>> =>
  pedir(`${rutaDe(clienteId, periodo, compraId)}/calcular`, calcularRespuestaSchema, {
    method: "POST",
    body: datos,
  });

/** Agrega una compra a mano: 201 con la fila y su cuadre; 409 `duplicado` trae el `id` de la existente. */
export const agregarCompra = (
  clienteId: string,
  periodo: string,
  datos: AgregarCompra,
): Promise<ResultadoCompras<AccionCompraRespuesta>> =>
  pedir(base(clienteId, periodo), accionCompraRespuestaSchema, {
    method: "POST",
    body: datos,
  });

// ---------------------------------------------------------------------------------------------
// Masivas, deshacer y rehacer, estado del periodo
// ---------------------------------------------------------------------------------------------

type CuerpoMasiva =
  MasivaClasificar | MasivaAceptar | MasivaExcluir | MasivaRestaurar;

const masiva = (
  clienteId: string,
  periodo: string,
  sufijo: "clasificar" | "aceptar" | "excluir" | "restaurar",
  body: CuerpoMasiva,
): Promise<ResultadoCompras<InformeMasiva>> =>
  pedir(`${base(clienteId, periodo)}/masivas/${sufijo}`, informeMasivaSchema, {
    method: "POST",
    body,
  });

export const masivaClasificarCompras = (
  clienteId: string,
  periodo: string,
  datos: MasivaClasificar,
) => masiva(clienteId, periodo, "clasificar", datos);

export const masivaAceptarCompras = (
  clienteId: string,
  periodo: string,
  datos: MasivaAceptar,
) => masiva(clienteId, periodo, "aceptar", datos);

export const masivaExcluirCompras = (
  clienteId: string,
  periodo: string,
  datos: MasivaExcluir,
) => masiva(clienteId, periodo, "excluir", datos);

export const masivaRestaurarCompras = (
  clienteId: string,
  periodo: string,
  datos: MasivaRestaurar,
) => masiva(clienteId, periodo, "restaurar", datos);

export const deshacerCompras = (
  clienteId: string,
  periodo: string,
): Promise<ResultadoCompras<DeshacerRespuesta>> =>
  pedir(`${base(clienteId, periodo)}/deshacer`, deshacerRespuestaSchema, {
    method: "POST",
  });

export const rehacerCompras = (
  clienteId: string,
  periodo: string,
): Promise<ResultadoCompras<DeshacerRespuesta>> =>
  pedir(`${base(clienteId, periodo)}/rehacer`, deshacerRespuestaSchema, {
    method: "POST",
  });

export const revisarPeriodoCompras = (
  clienteId: string,
  periodo: string,
): Promise<ResultadoCompras<EstadoPeriodoRespuesta>> =>
  pedir(`${base(clienteId, periodo)}/estado/revisar`, estadoPeriodoRespuestaSchema, {
    method: "POST",
  });

/** `estadoVisto` es el estado que vio quien reabre: si el periodo ya cambió, el servidor responde 409 `estado_invalido`. */
export const reabrirPeriodoCompras = (
  clienteId: string,
  periodo: string,
  datos: ReabrirPeriodo,
): Promise<ResultadoCompras<EstadoPeriodoRespuesta>> =>
  pedir(`${base(clienteId, periodo)}/estado/reabrir`, estadoPeriodoRespuestaSchema, {
    method: "POST",
    body: datos,
  });
