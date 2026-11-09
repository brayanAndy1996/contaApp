import {
  detalleLupaSchema,
  type ColumnaComparacion,
  type DetalleLupa,
  type EstadoXml,
} from "@contapp/shared";
import {
  esquemaTrabajo,
  falla,
  pedir,
  respuestaInvalida,
  rutaDe,
  type ErrorCompras,
  type ResultadoCompras,
} from "./compras";
import { obtenerSesion } from "./sesion";

// Cliente HTTP y textos de la lupa del comprobante (spec 016, D-8; plan, Frontend). Una función por ruta, cada
// respuesta validada con el esquema de `@contapp/shared`. Nada del XML se interpreta aquí: glosas, razón social y
// descripciones llegan ya validadas y se pintan como texto. Los montos son cadenas del servidor.

export type { DetalleLupa, EstadoXml };

// ---------------------------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------------------------

export const MENSAJES_LUPA = {
  tituloModal: (comprobante: string) => `Comprobante ${comprobante}`,
  cerrar: "Cerrar comprobante",
  anterior: "Compra anterior",
  siguiente: "Compra siguiente",
  posicion: (indice: number, cantidad: number) =>
    `Compra ${indice} de ${cantidad}`,
  ayudaTeclado:
    "← → cambian de compra · Enter acepta la sugerencia · Esc cierra",
  cargando: "Cargando el comprobante…",
  errorCarga: "No se pudo cargar el comprobante.",
  reintentar: "Reintentar",
  sinFila: "La compra ya no está en la lista.",

  secciones: {
    cabecera: "Cabecera",
    xml: "XML del comprobante",
    items: "Ítems del XML",
    comparacion: "Comparación SIRE y XML",
    hallazgos: "Hallazgos y sugerencia",
    historialCompra: "Historial de la compra",
    historialProveedor: "Historial del proveedor",
    acciones: "Acciones",
  },

  cabecera: {
    ruc: "RUC",
    razonSocial: "Razón social",
    proveedorNuevo: "Proveedor nuevo",
    tipo: "Tipo de comprobante",
    comprobante: "Serie y número",
    fecha: "Fecha de emisión",
    moneda: "Moneda",
    tipoCambio: "Tipo de cambio",
    origenSerie: "Origen de la serie",
    sinDato: "—",
  },
  origenSerie: { E: "Electrónica", F: "Física" } as const,
  tipos: {
    "01": "Factura",
    "03": "Boleta de venta",
    "07": "Nota de crédito",
    "08": "Nota de débito",
  } as Readonly<Record<string, string>>,

  // Estado del XML (RF-097a, RF-097b, CA-9, CA-11, CA-16).
  xml: {
    simulado: "XML simulado",
    real: "XML real",
    subidoPor: (quien: string, cuando: string) =>
      `XML subido por ${quien} el ${cuando}`,
    subido: "XML subido",
    pendiente: "Pendiente: se está obteniendo el XML.",
    sinSolicitar: "El XML de este comprobante aún no se solicitó.",
    noDisponible: "XML no disponible",
    causas: {
      no_encontrado: "SUNAT no entregó el XML de este comprobante.",
      credencial: "No se pudo obtener el XML con la credencial del cliente.",
      transitorio: "No se pudo obtener el XML ahora; se volverá a intentar.",
      no_aplica: "Este comprobante no tiene XML que obtener.",
    } as const,
    avisoMoneda: (monedaXml: string, monedaFila: string) =>
      `La moneda del XML (${monedaXml}) no coincide con la de la fila (${monedaFila}). Se muestran sin convertir.`,
    descargar: "Descargar XML",
    descargando: "Descargando…",
    obtener: "Obtener XML",
    reintentarObtener: "Reintentar",
    solicitando: "Solicitando…",
    solicitado: "Se solicitó el XML.",
    errorDescarga: "No se pudo descargar el XML.",
  },

  // Ítems.
  items: {
    descripcion: "Descripción",
    cantidad: "Cantidad",
    unidad: "Unidad",
    precioUnitario: "Precio unitario",
    valor: "Valor",
    afectacion: "Afectación",
    igv: "IGV",
    isc: "ISC",
    icbper: "ICBPER",
    tabla: "Ítems del XML",
    sinXml: "Sin XML: no hay ítems que mostrar.",
    sinItems: "El XML no trae ítems.",
    gravado: "Gravado",
    exonerado: "Exonerado",
    inafecto: "Inafecto",
    exportacion: "Exportación",
  },

  // Comparación (D-9, CA-14).
  comparacion: {
    tabla: "Comparación por columna entre el SIRE y el XML",
    columna: "Columna",
    sire: "SIRE",
    xml: "XML",
    estado: "Resultado",
    difiere: "Difiere",
    coincide: "Coincide",
    sinXml: "Sin XML",
    sinXmlNota: "Sin XML: no hay con qué comparar el SIRE.",
    columnas: {
      bi: "Base imponible (DG + DGNG + DNG)",
      igv: "IGV",
      noGravado: "No gravado",
      isc: "ISC",
      icbper: "ICBPER",
      otrosTributos: "Otros tributos",
      total: "Total",
    } satisfies Record<ColumnaComparacion, string>,
  },

  // Hallazgos y acciones.
  hallazgos: {
    sinHallazgos: "Sin hallazgos ni sugerencias.",
    aceptar: "Aceptar sugerencias",
    aceptarDeshabilitado: "Aceptar sugerencias (no disponible)",
    sugerenciaAceptada: "Sugerencia aceptada.",
  },

  // Historial del proveedor (RF-094).
  proveedor: {
    tabla: "Compras del proveedor en los últimos 6 periodos",
    periodo: "Periodo",
    comprobante: "Comprobante",
    destino: "Destino",
    excluida: "Excluida",
    sinHistorial: "El proveedor no tiene otras compras en los últimos 6 periodos.",
    si: "Sí",
    no: "No",
  },

  historial: "Historial",
  ocultarHistorial: "Ocultar historial",

  // Errores por código (016, D-8). Nunca el cuerpo crudo ni la causa interna.
  errores: {
    xml_existente: "Este comprobante ya tiene un XML guardado.",
    xml_invalido: "El archivo no es un XML válido.",
    xml_incompleto: "El XML no trae todos los datos del comprobante.",
    xml_ajeno: "El XML no corresponde a este comprobante.",
  } as Readonly<Record<string, string>>,
} as const;

/** Mensaje de un error de la lupa: los códigos de XML tienen texto propio; el resto sale de 015. */
export function mensajeDeErrorLupa(error: ErrorCompras): string {
  const texto = Object.hasOwn(MENSAJES_LUPA.errores, error.codigo)
    ? MENSAJES_LUPA.errores[error.codigo]
    : undefined;
  return texto ?? error.mensaje;
}

// ---------------------------------------------------------------------------------------------
// Presentación (texto, sin cálculo)
// ---------------------------------------------------------------------------------------------

/** «2026-10-20T15:00:00.000Z» → «2026-10-20 15:00 UTC» (texto, sin objetos de fecha). */
export const fechaLegibleUtc = (iso: string): string =>
  `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Nombre del tipo de comprobante con su código: «Factura (01)». Un código desconocido se muestra solo. */
export function etiquetaTipo(tipo: string): string {
  const nombre = MENSAJES_LUPA.tipos[tipo];
  return nombre === undefined ? tipo : `${nombre} (${tipo})`;
}

/** Afectación del IGV (catálogo 07): «10» → «Gravado (10)». Un código fuera del catálogo se muestra tal cual. */
export function etiquetaAfectacion(codigo: string): string {
  const T = MENSAJES_LUPA.items;
  if (/^1\d$/.test(codigo)) return `${T.gravado} (${codigo})`;
  if (/^2\d$/.test(codigo)) return `${T.exonerado} (${codigo})`;
  if (/^3\d$/.test(codigo)) return `${T.inafecto} (${codigo})`;
  if (codigo === "40") return `${T.exportacion} (${codigo})`;
  return codigo;
}

/** Quién subió el XML: los 8 primeros caracteres de su id, como el Historial de 015. */
export const autorCorto = (usuarioId: string): string => usuarioId.slice(0, 8);

// ---------------------------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------------------------

/** `GET …/:compraId/detalle`: solo lectura, no encola ni re-parsea. */
export const obtenerDetalleLupa = (
  clienteId: string,
  periodo: string,
  compraId: string,
): Promise<ResultadoCompras<DetalleLupa>> =>
  pedir(`${rutaDe(clienteId, periodo, compraId)}/detalle`, detalleLupaSchema);

/** `POST …/:compraId/xml/obtener`: encola el interactivo (202 `{trabajoId}`); 409 `xml_existente` o `cliente_archivado`. */
export const solicitarXml = (
  clienteId: string,
  periodo: string,
  compraId: string,
): Promise<ResultadoCompras<{ trabajoId: string }>> =>
  pedir(`${rutaDe(clienteId, periodo, compraId)}/xml/obtener`, esquemaTrabajo, {
    method: "POST",
  });

export type ResultadoDescargaXml =
  | { ok: true; status: number; archivo: Blob; nombre: string }
  | ErrorCompras;

/**
 * `GET …/:compraId/xml`: el XML como adjunto. `api()` solo lee JSON, así que esta ruta usa `fetch` con las
 * cabeceras de sesión y entrega el archivo como `Blob` para que la pantalla lo guarde; nunca se interpreta.
 */
export async function descargarXml(
  clienteId: string,
  periodo: string,
  compraId: string,
): Promise<ResultadoDescargaXml> {
  try {
    const sesion = await obtenerSesion();
    if (!sesion) return falla(401, null);
    const headers: Record<string, string> = {};
    if (sesion.estudioActivo) headers["X-Estudio"] = sesion.estudioActivo.id;
    const respuesta = await fetch(`/api${rutaDe(clienteId, periodo, compraId)}/xml`, {
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
      /filename="([A-Za-z0-9._-]{1,100})"/.exec(disposicion)?.[1] ?? "comprobante.xml";
    return { ok: true, status: respuesta.status, archivo, nombre };
  } catch {
    return respuestaInvalida(0);
  }
}
