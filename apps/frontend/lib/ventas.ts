import type {
  CorrelatividadVentasDto,
  DiferenciaVentasDto,
  PaginaVentasDto,
  PropuestaVentasDto,
  ResumenVentasDto,
  SaltoJustificarInput,
  TamanoPaginaVentas,
  VentaAgregarInput,
  VentaDto,
  VistaPreviaVentas,
  MotivoFilaVenta,
  MotivoAdvertenciaVenta,
} from "@contapp/shared";
import { MENSAJES } from "./acceso";
import { api, type RespuestaApi } from "./api";

// Cliente HTTP y textos de la pantalla de ventas (spec 013, D14). Solo envía y recibe lo del contrato de
// `@contapp/shared`. Los montos son SIEMPRE cadenas del servidor: aquí no se convierten, suman ni comparan.

export type {
  CorrelatividadVentasDto,
  DiferenciaVentasDto,
  PaginaVentasDto,
  PropuestaVentasDto,
  ResumenVentasDto,
  VentaDto,
  VistaPreviaVentas,
};

export const MENSAJES_VENTAS = {
  titulo: "Ventas",
  tituloImportar: "Importar propuesta de ventas",
  etiquetaPeriodo: "Periodo (AAAAMM)",
  periodoInvalido: "Ingresa un periodo válido (AAAAMM).",
  descargar: "Descargar",
  reintentar: "Reintentar",
  importar: "Importar propuesta",
  enCola: (n: number) => `En cola · posición ${n}`,
  enColaSinPosicion: "En cola",
  ejecutando: "Descargando la propuesta…",
  descargaCancelada: "La descarga se canceló.",
  descargaFallida: "La descarga falló",
  resumenDescarga: (nuevos: number, difieren: number) =>
    `${nuevos} nuevos, ${difieren} difieren`,
  ultimaDescarga: (fecha: string) => `Última descarga: ${fecha}`,
  sinDescargas: "Aún no hay descargas de este periodo.",
  filasPorPagina: "Filas por página",
  siguiente: "Siguiente",
  anterior: "Anterior",
  filtrar: "Filtrar",
  filtrosInvalidos: "Revisa los filtros.",
  todasLimitada: (total: string) =>
    `Se muestran las primeras 5.000 filas de ${total}. Para ver el resto, usa la paginación.`,
  buscar: "Buscar",
  filtroTipo: "Tipo",
  filtroSerie: "Serie",
  montoMinimo: "Monto mínimo",
  montoMaximo: "Monto máximo",
  tablaVentas: "Ventas del periodo",
  sinVentas: "No hay ventas en este periodo.",
  importesEnSoles: "Importes en soles",
  avisoUsdSinTipoCambio:
    "Hay ventas en USD sin tipo de cambio: no se incluyen en el resumen.",
  faltaUno: (clave: string) => `Falta ${clave}`,
  faltaRango: (desde: string, hasta: string) => `Faltan ${desde} a ${hasta}`,
  numeracionCompleta: "Numeración completa",
  noEvaluable: "No evaluable",
  justificado: "Justificado",
  justificadoEnParte: "Justificado en parte",
  porRevisar: (n: number) => `Saltos por revisar: ${n}`,
  nombreSerie: (tipo: string, serie: string) => `Tipo ${tipo} · serie ${serie}`,
  justificar: "Justificar",
  formularioJustificar: "Justificar salto",
  comentarioRequerido: "Escribe un comentario de 1 a 500 caracteres.",
  guardar: "Guardar",
  cancelar: "Cancelar",
  etiquetaComentario: "Comentario",
  justificarInvalido:
    "No se pudo justificar: revisa el comentario y el rango del salto.",
  agregarVenta: "Agregar venta",
  agregarVentaManual: "Agregar venta manual",
  formularioAgregar: "Agregar venta",
  agregar: "Agregar",
  campos: {
    tipo: "Tipo",
    serie: "Serie",
    numero: "Número",
    fecha: "Fecha de emisión",
    moneda: "Moneda",
    tipoCambio: "Tipo de cambio",
    tipoDoc: "Tipo de documento",
    documento: "Documento",
    baseGravada: "Base gravada",
    igv: "IGV",
    exonerada: "Exonerada",
    inafecta: "Inafecta",
    isc: "ISC",
    icbper: "ICBPER",
    otros: "Otros",
    total: "Total",
  },
  ventaAgregada: "Venta agregada.",
  datosInvalidos: "Revisa los datos de la venta.",
  ventaDuplicada:
    "Ya existe una venta con ese tipo, serie y número en el periodo.",
  tituloDiferencias: "Diferencias de la última descarga",
  sinDiferencias: "La última descarga no trajo diferencias.",
  clienteArchivado: "El cliente está archivado y es de solo lectura.",
  archivo: "Archivo (.xlsx, .csv o .txt)",
  revisarArchivo: "Revisar archivo",
  confirmarImportacion: "Confirmar importación",
  verVentas: "Ver ventas del periodo",
  validas: (n: number) => `Filas válidas: ${n}`,
  conError: (n: number) => `Filas con error: ${n}`,
  estadoFila: {
    valida: "Válida",
    conError: "Con error",
    // D22: válida pero con algo que revisar; no bloquea la importación.
    conAdvertencia: "Válida con advertencia",
  },
  conAdvertencia: (n: number) => `Filas con advertencia: ${n}`,
  avisoAdvertencias:
    "Las filas con advertencia se pueden confirmar: se guardan tal cual.",
  // Códigos cerrados de `MOTIVOS_ADVERTENCIA_VENTA` (shared); nunca el monto ni el contenido de la celda.
  advertencias: {
    descuadre:
      "El total no cuadra con la suma de los componentes; se guardará tal cual.",
    tipo_cambio_requerido:
      "Falta el tipo de cambio de la venta en USD; no se incluirá en el resumen.",
  } satisfies Record<MotivoAdvertenciaVenta, string>,
  // D26: marca de una venta del SIRE cuyo total no cuadra con la suma de los componentes (se muestra tal cual llegó).
  noCuadra: "No cuadra",
  // D23: revertir una justificación y quitar una venta agregada a mano (ambos piden confirmación).
  revertir: "Revertir",
  quitar: "Quitar",
  confirmar: "Confirmar",
  confirmarRevertir: (clave: string) =>
    `¿Revertir la justificación del salto ${clave}? Quedará registro de quién la revirtió y cuándo.`,
  confirmarQuitar: (clave: string) =>
    `¿Quitar la venta ${clave} agregada a mano? Esta acción no se puede deshacer.`,
  justificacionRevertida: "Justificación revertida.",
  ventaQuitada: "Venta quitada.",
  errorRevertir: "No se pudo revertir la justificación.",
  errorQuitar: "No se pudo quitar la venta.",
  corregirFilas:
    "Corrige las filas con error: si alguna falla no se guarda nada.",
  layoutNoOficial:
    "La importación no está disponible: el diseño de columnas es provisional y no oficial.",
  archivoInvalido:
    "El archivo no es válido. Usa un .xlsx, .csv o .txt con el layout provisional.",
  archivoGrande: "El archivo supera el tamaño permitido.",
  propuestaGrande: "La propuesta supera las 20.000 filas permitidas.",
  filasOcultas: (n: number) =>
    `Se omiten ${n} filas válidas de la lista; las filas con error se muestran todas.`,
  // Códigos cerrados de `MOTIVOS_FILA_VENTA` (shared); el texto nunca incluye el contenido de la celda.
  motivos: {
    campo_obligatorio: "Falta un dato obligatorio.",
    tipo_invalido: "El tipo de comprobante no es válido.",
    serie_invalida: "La serie no es válida.",
    numero_invalido: "El número no es válido.",
    fecha_invalida: "La fecha no es válida.",
    moneda_invalida: "La moneda no es válida.",
    tipo_cambio_invalido: "El tipo de cambio no es válido.",
    documento_invalido: "El documento de la contraparte no es válido.",
    monto_invalido: "Un monto no es válido.",
    celda_peligrosa: "La fila contiene una fórmula o un carácter no permitido.",
  } satisfies Record<MotivoFilaVenta, string>,
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
} as const;

const codigoDe = (datos: unknown): string =>
  (datos as { codigo?: string } | null)?.codigo ?? "";

/**
 * Mensaje visible de un error al justificar o agregar. `texto400` es el que corresponde a un 400 de esa
 * acción; nunca se muestra el cuerpo de la respuesta.
 */
export function mensajeDeErrorVentas(
  status: number,
  datos: unknown,
  texto400: string,
): string {
  if (status === 400) return texto400;
  if (status === 403) return MENSAJES.sinPermiso;
  if (status === 409) {
    const codigo = codigoDe(datos);
    if (codigo === "cliente_archivado") return MENSAJES_VENTAS.clienteArchivado;
    if (codigo === "duplicado") return MENSAJES_VENTAS.ventaDuplicada;
  }
  return MENSAJES.errorGeneral;
}

/** Mensaje visible de un error de la vista previa o de la confirmación de la importación. */
export function mensajeDeErrorImportacionVentas(
  status: number,
  datos: unknown,
): string {
  const codigo = codigoDe(datos);
  if (status === 413) return MENSAJES_VENTAS.archivoGrande;
  if (status === 403) return MENSAJES.sinPermiso;
  if (status === 422) {
    if (codigo === "layout_no_oficial") return MENSAJES_VENTAS.layoutNoOficial;
    if (codigo === "propuesta_demasiado_grande")
      return MENSAJES_VENTAS.propuestaGrande;
  }
  if (status === 400 && codigo === "archivo_invalido")
    return MENSAJES_VENTAS.archivoInvalido;
  if (status === 409 && codigo === "cliente_archivado")
    return MENSAJES_VENTAS.clienteArchivado;
  return MENSAJES.errorGeneral;
}

/** Nombre del tipo de comprobante (catálogo 01 de SUNAT) para el `title` de las celdas; `undefined` si no se conoce. */
export const NOMBRE_TIPO_COMPROBANTE: Readonly<Record<string, string>> = {
  "01": "Factura",
  "03": "Boleta de venta",
  "07": "Nota de crédito",
  "08": "Nota de débito",
};

/** `AAAAMM` con mes 01 a 12. */
export const PERIODO_VALIDO = /^\d{4}(0[1-9]|1[0-2])$/;

/** Entero con puntos de miles («5001» → «5.001»). Solo para contadores de filas, nunca para montos. */
export const conMiles = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** Filtros de la grilla tal como se escriben (cadenas; vacío = sin filtro). */
export interface FiltrosGrilla {
  q: string;
  tipo: string;
  serie: string;
  min: string;
  max: string;
}

export const SIN_FILTROS: FiltrosGrilla = {
  q: "",
  tipo: "",
  serie: "",
  min: "",
  max: "",
};

const base = (clienteId: string, periodo: string): string =>
  `/clientes/${encodeURIComponent(clienteId)}/periodos/${encodeURIComponent(periodo)}/ventas`;

/** Query de la grilla: solo manda lo que tiene valor; los textos viajan tal cual, codificados por `URLSearchParams`. */
export function consultaDeGrilla(
  pagina: number,
  tamano: TamanoPaginaVentas,
  filtros: FiltrosGrilla,
): string {
  const q = new URLSearchParams();
  q.set("pagina", String(pagina));
  q.set("tamano", String(tamano));
  for (const clave of ["q", "tipo", "serie", "min", "max"] as const) {
    if (filtros[clave] !== "") q.set(clave, filtros[clave]);
  }
  return q.toString();
}

export const listarVentas = (
  clienteId: string,
  periodo: string,
  pagina: number,
  tamano: TamanoPaginaVentas,
  filtros: FiltrosGrilla,
): Promise<RespuestaApi<PaginaVentasDto>> =>
  api<PaginaVentasDto>(
    `${base(clienteId, periodo)}?${consultaDeGrilla(pagina, tamano, filtros)}`,
  );

export const obtenerResumenVentas = (
  clienteId: string,
  periodo: string,
): Promise<RespuestaApi<ResumenVentasDto>> =>
  api<ResumenVentasDto>(`${base(clienteId, periodo)}/resumen`);

export const obtenerCorrelatividad = (
  clienteId: string,
  periodo: string,
): Promise<RespuestaApi<CorrelatividadVentasDto>> =>
  api<CorrelatividadVentasDto>(`${base(clienteId, periodo)}/correlatividad`);

/** Descargas e importaciones del periodo, la más reciente primero. */
export const listarPropuestas = (
  clienteId: string,
  periodo: string,
): Promise<RespuestaApi<PropuestaVentasDto[]>> =>
  api<PropuestaVentasDto[]>(`${base(clienteId, periodo)}/propuestas`);

export const listarDiferencias = (
  clienteId: string,
  periodo: string,
  propuestaId: string,
): Promise<RespuestaApi<DiferenciaVentasDto[]>> =>
  api<DiferenciaVentasDto[]>(
    `${base(clienteId, periodo)}/propuestas/${encodeURIComponent(propuestaId)}/diferencias`,
  );

/** Encola la descarga: 202 `{trabajoId}`. */
export const descargarPropuesta = (
  clienteId: string,
  periodo: string,
): Promise<RespuestaApi<{ trabajoId: string }>> =>
  api<{ trabajoId: string }>(`${base(clienteId, periodo)}/descargar`, {
    method: "POST",
  });

export const justificarSalto = (
  clienteId: string,
  periodo: string,
  datos: SaltoJustificarInput,
): Promise<RespuestaApi<{ id: string }>> =>
  api<{ id: string }>(`${base(clienteId, periodo)}/saltos-justificados`, {
    method: "POST",
    body: datos,
  });

/** Revierte una justificación vigente (D8): 204. La fila queda con quién y cuándo la revirtió. */
export const revertirJustificacion = (
  clienteId: string,
  periodo: string,
  justificacionId: string,
): Promise<RespuestaApi<null>> =>
  api<null>(
    `${base(clienteId, periodo)}/saltos-justificados/${encodeURIComponent(justificacionId)}`,
    { method: "DELETE" },
  );

/** Quita una venta de origen `manual` (D5): 204. Las del SIRE no se pueden quitar (409). */
export const quitarVenta = (
  clienteId: string,
  periodo: string,
  ventaId: string,
): Promise<RespuestaApi<null>> =>
  api<null>(`${base(clienteId, periodo)}/${encodeURIComponent(ventaId)}`, {
    method: "DELETE",
  });

export const agregarVenta = (
  clienteId: string,
  periodo: string,
  datos: VentaAgregarInput,
): Promise<RespuestaApi<VentaDto>> =>
  api<VentaDto>(base(clienteId, periodo), { method: "POST", body: datos });

/** Vista previa de la importación: el archivo viaja como bytes crudos. */
export const vistaPreviaImportacion = (
  clienteId: string,
  periodo: string,
  archivo: Blob,
): Promise<RespuestaApi<VistaPreviaVentas>> =>
  api<VistaPreviaVentas>(`${base(clienteId, periodo)}/importar/vista-previa`, {
    method: "POST",
    cuerpoCrudo: archivo,
  });

export const confirmarImportacion = (
  clienteId: string,
  periodo: string,
  archivo: Blob,
): Promise<RespuestaApi<{ propuesta: PropuestaVentasDto }>> =>
  api<{ propuesta: PropuestaVentasDto }>(
    `${base(clienteId, periodo)}/importar/confirmar`,
    { method: "POST", cuerpoCrudo: archivo },
  );
