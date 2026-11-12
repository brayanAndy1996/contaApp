import {
  detalleLupaSchema,
  filaCompraVistaSchema,
  vistaPreviaDesdeXmlSchema,
  type CampoXmlAjeno,
  type ColumnaComparacion,
  type DestinoCompra,
  type DetalleLupa,
  type EstadoXml,
  type FilaCompraVista,
  type VistaPreviaDesdeXml,
} from "@contapp/shared";
import {
  esquemaTrabajo,
  falla,
  pedir,
  respuestaInvalida,
  rutaCompras,
  rutaDe,
  type ErrorCompras,
  type ResultadoCompras,
} from "./compras";
import { obtenerSesion } from "./sesion";

// Cliente HTTP y textos de la lupa del comprobante (spec 016, D-8; plan, Frontend). Una función por ruta, cada
// respuesta validada con el esquema de `@contapp/shared`. Nada del XML se interpreta aquí: glosas, razón social y
// descripciones llegan ya validadas y se pintan como texto. Los montos son cadenas del servidor.

export type { DetalleLupa, EstadoXml, VistaPreviaDesdeXml };

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
    "← → cambian de compra · Enter abre la aceptación de la sugerencia y un segundo Enter la confirma · Esc cierra",
  editar: "Editar",
  editarAyuda: "Cierra el comprobante y abre esta compra en edición en la lista.",
  editarNoDisponible:
    "No se pudo abrir la edición: la compra no está en la lista actual o no se puede editar.",
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

  // Subir XML (T16, CA-12) y agregar desde XML (CA-13).
  subir: {
    boton: "Subir XML",
    arrastrar: "o arrastra el archivo XML aquí",
    zona: "Zona para soltar el XML",
    subiendo: "Subiendo…",
    leyendo: "Leyendo el XML…",
    subido: "XML subido.",
    vacio: "El archivo está vacío.",
    grande: "El archivo pesa más de 1 MiB: no se envió.",
  },
  desdeXml: {
    titulo: "Agregar desde XML",
    volver: "Quitar el XML",
    resumen: "Datos leídos del XML",
    proveedor: "Proveedor",
    montos: "Montos del XML",
    base: "Base imponible",
    destino: "Destino de la base imponible y el IGV",
    elegirDestino: "Elige el destino",
    destinoObligatorio: "Elige el destino de la compra.",
    tipoCambio: "Tipo de cambio",
    tipoCambioAyuda: "El XML está en USD: indica el tipo de cambio de la compra.",
    tipoCambioInvalido: "Ingresa el tipo de cambio con hasta 3 decimales, por ejemplo 3.752.",
    agregar: "Agregar compra",
    agregando: "Agregando…",
    agregada: "Compra agregada desde el XML.",
    yaExiste: "Este comprobante ya está en la propuesta.",
  },

  // Errores por código (016, D-8). Nunca el cuerpo crudo ni la causa interna.
  errores: {
    xml_existente: "Este comprobante ya tiene un XML guardado.",
    xml_invalido: "El archivo no es un XML válido.",
    xml_incompleto: "El XML no trae todos los datos del comprobante.",
    xml_ajeno: "El XML no corresponde a este comprobante.",
  } as Readonly<Record<string, string>>,
} as const;

/** Qué campo de identidad no coincidió (`xml_ajeno`). Texto fijo por campo: nada del XML. */
const CAMPOS_AJENOS = {
  ruc: "el RUC del emisor",
  tipo: "el tipo de comprobante",
  serie: "la serie",
  numero: "el número",
  receptor: "el RUC del receptor",
} as const satisfies Record<CampoXmlAjeno, string>;

/** «el RUC del emisor y la serie» (texto, sin tocar nada del XML). */
function listaDeCampos(campos: readonly CampoXmlAjeno[]): string {
  const nombres = campos.map((c) => CAMPOS_AJENOS[c]);
  if (nombres.length <= 1) return nombres.join("");
  return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
}

/**
 * Mensaje de un error al subir un XML. `compra` es la lupa (el XML debe ser de ese comprobante); `cliente` es
 * «Agregar desde XML» (solo el receptor puede no coincidir). 413 no trae cuerpo JSON: se dice por estado.
 */
export function mensajeDeErrorXml(error: ErrorCompras, ambito: "compra" | "cliente" = "compra"): string {
  if (error.status === 413) return MENSAJES_LUPA.subir.grande;
  if (error.codigo === "xml_ajeno" && error.campos !== undefined && error.campos.length > 0) {
    const quien = ambito === "compra" ? "a este comprobante" : "a este cliente";
    return `El XML no corresponde ${quien}: no coincide ${listaDeCampos(error.campos)}.`;
  }
  return mensajeDeErrorLupa(error);
}

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

// ---------------------------------------------------------------------------------------------
// Subir XML (T16)
// ---------------------------------------------------------------------------------------------

/** Tope del cuerpo (D-3): 1 MiB. El navegador lo comprueba antes de enviar; el servidor vuelve a validarlo (413). */
export const TOPE_XML_BYTES = 1024 * 1024;

/** Motivo por el que el archivo no se envía, o `null` si puede enviarse. No lee el contenido. */
export function validarArchivoXml(archivo: Pick<Blob, "size">): string | null {
  if (archivo.size === 0) return MENSAJES_LUPA.subir.vacio;
  if (archivo.size > TOPE_XML_BYTES) return MENSAJES_LUPA.subir.grande;
  return null;
}

/** `POST …/:compraId/xml`: el XML como cuerpo crudo. 200 con el detalle de la lupa; 409/413/422 con su código. */
export const subirXmlCompra = (
  clienteId: string,
  periodo: string,
  compraId: string,
  archivo: Blob,
): Promise<ResultadoCompras<DetalleLupa>> =>
  pedir(`${rutaDe(clienteId, periodo, compraId)}/xml`, detalleLupaSchema, {
    method: "POST",
    cuerpoCrudo: archivo,
  });

/** `POST …/compras/desde-xml/vista-previa`: lee el XML y devuelve los campos; no guarda nada. */
export const vistaPreviaDesdeXml = (
  clienteId: string,
  periodo: string,
  archivo: Blob,
): Promise<ResultadoCompras<VistaPreviaDesdeXml>> =>
  pedir(`${rutaCompras(clienteId, periodo)}/desde-xml/vista-previa`, vistaPreviaDesdeXmlSchema, {
    method: "POST",
    cuerpoCrudo: archivo,
  });

/** `POST …/compras/desde-xml?destino=…[&tipoCambio=…]`: crea la compra `agregada` y guarda el XML. 201 con la fila. */
export const agregarDesdeXml = (
  clienteId: string,
  periodo: string,
  archivo: Blob,
  destino: DestinoCompra,
  tipoCambio?: string,
): Promise<ResultadoCompras<FilaCompraVista>> => {
  const consulta = new URLSearchParams({ destino });
  if (tipoCambio !== undefined) consulta.set("tipoCambio", tipoCambio);
  return pedir(`${rutaCompras(clienteId, periodo)}/desde-xml?${consulta.toString()}`, filaCompraVistaSchema, {
    method: "POST",
    cuerpoCrudo: archivo,
  });
};
