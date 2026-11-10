import {
  previoArchivoSchema,
  versionArchivoSchema,
  type GenerarArchivo,
  type PrevioArchivoDto,
  type VersionArchivoDto,
} from "@contapp/shared";
import { MENSAJES } from "./acceso";
import { api } from "./api";
import { obtenerSesion } from "./sesion";

// Cliente HTTP y textos del panel «Generar archivo» (spec 012b, T14; D1, D2, D5, D9, P-2, P-4, P-7, P-10).
// Habla con `/clientes/:clienteId/periodos/:periodo/{compras|ventas}/archivos`. Toda respuesta se valida con
// los esquemas de `@contapp/shared`: si no calza, error genérico y nada a medias. Los montos son SIEMPRE
// cadenas del servidor; aquí no se calculan (se muestran con `conMiles` de `montos-compras.ts`).

export type { GenerarArchivo, PrevioArchivoDto, VersionArchivoDto };

export type LibroArchivo = "compras" | "ventas";

export const PERMISO_VER_ARCHIVOS = "clientes.ver";
export const PERMISO_GENERAR_ARCHIVO = "sire.aprobar_generar";

export const MENSAJES_ARCHIVO = {
  abrir: "Generar archivo",
  cerrar: "Cerrar",
  titulo: "Generar archivo",
  subtitulo: (libro: LibroArchivo) =>
    libro === "compras"
      ? "Archivo TXT del Registro de Compras Electrónico (RCE) para el SIRE"
      : "Archivo TXT del Registro de Ventas e Ingresos Electrónico (RVIE) para el SIRE",
  cargando: "Cargando el previo…",
  errorCarga: "No se pudo cargar el previo del archivo.",
  reintentar: "Reintentar",
  provisional: "Provisional: no subir a SUNAT",
  provisionalAyuda:
    "El formato del archivo aún no es el oficial de SUNAT. Sirve para revisar, no para presentar.",
  generable: "El archivo está listo para generarse.",
  noGenerable: "El archivo no se puede generar todavía.",
  motivos: {
    prevalidacion_fallida: "Hay errores por corregir antes de generar.",
    formato_no_oficial: "El formato del archivo aún no es el oficial de SUNAT.",
    periodo_generado: "El periodo ya está generado: reábrelo para generar de nuevo.",
    cliente_archivado: "El cliente está archivado y es de solo lectura.",
  },
  tituloErrores: "Errores",
  sinErrores: "Sin errores.",
  ubicarFila: "Ubicar en la grilla",
  diferencia: (monto: string) => `Diferencia: ${monto}`,
  erroresOmitidos: (n: number) =>
    n === 1 ? "Y 1 error más que no se muestra." : `Y ${n} errores más que no se muestran.`,
  erroresVentasAyuda:
    "Las ventas llegaron así del SIRE: el error se corrige en el sistema de facturación. Para generar este periodo, puedes excluir la venta con un motivo; no irá en el archivo.",
  excluir: "Excluir",
  excluirVenta: (comprobante: string) => `Excluir la venta ${comprobante}`,
  tituloExcluidas: "Ventas excluidas",
  excluidasAyuda: "Estas ventas no irán en el archivo. Restaurarlas las vuelve a validar.",
  excluidaMotivo: (motivo: string) => `Motivo: ${motivo}`,
  restaurar: "Restaurar",
  restaurarVenta: (comprobante: string) => `Restaurar la venta ${comprobante}`,
  excluidasOmitidas: (n: number) =>
    n === 1 ? "Y 1 venta excluida más que no se muestra." : `Y ${n} ventas excluidas más que no se muestran.`,
  tituloAvisos: "Avisos",
  avisosOmitidos: "Los avisos no impiden generar el archivo.",
  tituloResumen: "Resumen de cambios del archivo",
  modificadas: "Modificadas",
  excluidas: "Excluidas",
  agregadas: "Agregadas",
  impactoIgv: "Impacto en el IGV",
  impactoDestino: {
    DG: "DG",
    DGNG: "DGNG",
    DNG: "DNG",
    total: "Total",
  },
  sinConvertir: (n: number) =>
    n === 1
      ? "1 fila en USD no se incluye en el impacto: falta su tipo de cambio."
      : `${n} filas en USD no se incluyen en el impacto: falta su tipo de cambio.`,
  formato: (id: string, version: string) => `Formato ${id} · versión ${version}`,
  generar: "Generar",
  generando: "Generando…",
  generacionEnCola: (n: number) => `En cola · posición ${n}`,
  generacionEnColaSinPosicion: "En cola",
  generacionEjecutando: "Generando el archivo…",
  verTrabajos: "Ver trabajos",
  generacionCompletada: "Archivo generado.",
  generacionCancelada: "La generación se canceló.",
  generacionFallida:
    "No se pudo generar el archivo. Se recargó el previo: revisa su estado.",
  seRecargo: "Se recargó el previo: revísalo y vuelve a generar.",
  sinPermisoGenerar: "No tienes permiso para generar el archivo.",
  tituloVersiones: "Versiones generadas",
  sinVersiones: "Aún no se generó ningún archivo de este periodo.",
  version: (n: number) => `Versión ${n}`,
  generadoEn: (fecha: string) => `Generado el ${fecha}`,
  lineas: (n: number) => (n === 1 ? "1 línea" : `${n} líneas`),
  descargar: "Descargar",
  descargarVersion: (n: number) => `Descargar la versión ${n}`,
  descargando: "Descargando…",
  errorDescarga: "No se pudo descargar el archivo.",
  reabiertoTrasUltima: "Reabierto después de la última versión",
  errores: {
    prevalidacion_fallida: "Hay errores por corregir antes de generar el archivo.",
    formato_no_oficial: "El formato del archivo aún no es el oficial de SUNAT.",
    resumen_cambiado: "El periodo cambió desde que viste el previo.",
    estado_invalido: "El estado del periodo cambió desde que viste el previo.",
    periodo_generado: "El periodo ya está generado: reábrelo para generar de nuevo.",
    periodo_revisado:
      "El periodo está revisado: solo quien puede aprobar y generar lo modifica.",
    cliente_archivado: "El cliente está archivado y es de solo lectura.",
    archivo_alterado: "El archivo guardado no coincide con su huella: no se puede descargar.",
    solicitud_invalida: "Revisa los datos: la solicitud no es válida.",
    respuesta_invalida: MENSAJES.errorGeneral,
  } as Readonly<Record<string, string>>,
} as const;

export interface ErrorArchivo {
  ok: false;
  status: number;
  /** Código del servidor, `""` si no hubo, o `"respuesta_invalida"` si la respuesta no cumplió el esquema. */
  codigo: string;
  mensaje: string;
  /** Hay que volver a pedir el previo (409 o 422 de la generación: P-10). */
  recargar: boolean;
}

export type ResultadoArchivo<T> =
  | { ok: true; status: number; datos: T }
  | ErrorArchivo;

const codigoDe = (datos: unknown): string => {
  const c = (datos as { codigo?: unknown } | null)?.codigo;
  return typeof c === "string" ? c : "";
};

/** Mensaje visible por código del servidor y, si no se conoce, por estado HTTP. Nunca muestra el cuerpo. */
export function mensajeDeErrorArchivo(status: number, datos: unknown): string {
  const porCodigo = MENSAJES_ARCHIVO.errores[codigoDe(datos)];
  if (porCodigo !== undefined) return porCodigo;
  if (status === 403) return MENSAJES.sinPermiso;
  if (status === 404) return MENSAJES.noEncontrado;
  return MENSAJES.errorGeneral;
}

const falla = (status: number, datos: unknown): ErrorArchivo => ({
  ok: false,
  status,
  codigo: codigoDe(datos),
  mensaje: mensajeDeErrorArchivo(status, datos),
  recargar: status === 409 || status === 422,
});

const respuestaInvalida = (status: number): ErrorArchivo => ({
  ok: false,
  status,
  codigo: "respuesta_invalida",
  mensaje: MENSAJES.errorGeneral,
  recargar: false,
});

interface Esquema<T> {
  safeParse(valor: unknown): { success: boolean; data?: T };
}

async function pedir<T>(
  ruta: string,
  esquema: Esquema<T>,
  opciones: { method?: string; body?: unknown } = {},
): Promise<ResultadoArchivo<T>> {
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

const esquemaVersiones: Esquema<VersionArchivoDto[]> = {
  safeParse(valor) {
    if (!Array.isArray(valor)) return { success: false };
    const datos: VersionArchivoDto[] = [];
    for (const elemento of valor as unknown[]) {
      const p = versionArchivoSchema.safeParse(elemento);
      if (!p.success) return { success: false };
      datos.push(p.data);
    }
    return { success: true, data: datos };
  },
};

/** `/clientes/:clienteId/periodos/:periodo/{libro}/archivos`. */
export const rutaArchivos = (
  clienteId: string,
  periodo: string,
  libro: LibroArchivo,
): string =>
  `/clientes/${encodeURIComponent(clienteId)}/periodos/${encodeURIComponent(periodo)}/${libro}/archivos`;

/** `GET …/archivos/previo` (`clientes.ver`). */
export const obtenerPrevioArchivo = (
  clienteId: string,
  periodo: string,
  libro: LibroArchivo,
): Promise<ResultadoArchivo<PrevioArchivoDto>> =>
  pedir(`${rutaArchivos(clienteId, periodo, libro)}/previo`, previoArchivoSchema);

/** `GET …/archivos` (`clientes.ver`): la mayor versión primero. */
export const listarVersionesArchivo = (
  clienteId: string,
  periodo: string,
  libro: LibroArchivo,
): Promise<ResultadoArchivo<VersionArchivoDto[]>> =>
  pedir(rutaArchivos(clienteId, periodo, libro), esquemaVersiones);

/**
 * `POST …/archivos` (`sire.aprobar_generar`): envía el estado y la huella del previo que la persona vio (P-2).
 * 202 `{trabajoId}`; 409 y 422 piden recargar el previo (P-10).
 */
export const generarArchivo = (
  clienteId: string,
  periodo: string,
  libro: LibroArchivo,
  cuerpo: GenerarArchivo,
): Promise<ResultadoArchivo<{ trabajoId: string }>> =>
  pedir(rutaArchivos(clienteId, periodo, libro), esquemaTrabajo, {
    method: "POST",
    body: cuerpo,
  });

export type ResultadoDescarga =
  | { ok: true; status: number; archivo: Blob; nombre: string }
  | ErrorArchivo;

/**
 * ZIP de una versión (`clientes.ver`, P-4). `api()` solo lee JSON, así que esta ruta usa `fetch` con las mismas
 * cabeceras de sesión y entrega el archivo como `Blob`; nunca interpreta su contenido.
 */
export async function descargarVersionArchivo(
  clienteId: string,
  periodo: string,
  libro: LibroArchivo,
  archivoId: string,
  nombreZip: string,
): Promise<ResultadoDescarga> {
  try {
    const sesion = await obtenerSesion();
    if (!sesion) return falla(401, null);
    const headers: Record<string, string> = {};
    if (sesion.estudioActivo) headers["X-Estudio"] = sesion.estudioActivo.id;
    const ruta = `/api${rutaArchivos(clienteId, periodo, libro)}/${encodeURIComponent(archivoId)}/zip`;
    const respuesta = await fetch(ruta, {
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
      /filename="([A-Za-z0-9._-]{1,100})"/.exec(disposicion)?.[1] ?? nombreZip;
    return { ok: true, status: respuesta.status, archivo, nombre };
  } catch {
    return respuestaInvalida(0);
  }
}
