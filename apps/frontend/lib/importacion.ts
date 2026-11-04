import {
  informeImportacionSchema,
  vistaPreviaSchema,
  type InformeImportacion,
  type MotivoFilaImportacion,
  type VistaPrevia,
} from "@contapp/shared";
import { api } from "./api";
import { MENSAJES } from "./acceso";

// Llamadas HTTP de la importación de clientes (spec 007b, D7–D9). El archivo viaja como cuerpo crudo y
// solo vive en memoria del paso; lo que devuelve el backend ya no lleva claves. Aquí no se calcula nada
// de negocio ni se lee el contenido del archivo.

export type { InformeImportacion, VistaPrevia };

export const URL_PLANTILLA = "/api/clientes/importacion/plantilla";
export const MASCARA_CLAVE = "••••";

export const MENSAJES_IMPORTACION = {
  titulo: "Importar clientes",
  plantilla: "Descargar plantilla",
  archivoInvalido:
    "El archivo no es válido. Usa la plantilla (.xlsx) o un .csv.",
  columnasFaltantes:
    "Faltan columnas en la cabecera. Descarga la plantilla y úsala.",
  demasiadasFilas: "El archivo supera las 1.000 filas permitidas.",
  archivoGrande: "El archivo supera los 2 MB permitidos.",
  estadoFila: { valida: "Válida", conError: "Con error" },
  validas: (n: number) => `Filas válidas: ${n}`,
  conError: (n: number) => `Filas con error: ${n}`,
  cupoLibre: (n: number) => `Cupo de RUCs disponible: ${n}`,
  excedentes: (n: number) => `Excedentes que no caben: ${n}`,
  creadas: (n: number) => `Clientes creados: ${n}`,
  consultasEncoladas: (n: number) => `Consultas de RUC encoladas: ${n}`,
  consultasOmitidas: (n: number) => `Consultas de RUC omitidas: ${n}`,
} as const;

export const MOTIVOS_FILA: Record<MotivoFilaImportacion, string> = {
  ruc_invalido: "El RUC no es válido.",
  duplicado_en_archivo: "RUC repetido en el archivo.",
  duplicado: "Ya existe un cliente con ese RUC.",
  responsable_inexistente: "El responsable no existe en el estudio.",
  responsable_no_asignable: "El responsable no puede ser asignado a clientes.",
  credencial_incompleta: "La credencial está incompleta.",
  celda_peligrosa: "La fila contiene una fórmula o un carácter no permitido.",
  cupo_rucs: "No cabe en el cupo de RUCs de tu plan.",
};

const MOTIVO_DUPLICADO_ARCHIVADO =
  "Ya existe un cliente archivado con ese RUC. Reactívalo desde su ficha.";

/** Texto del motivo; un duplicado de un cliente archivado sugiere reactivarlo. */
export function textoMotivo(
  motivo: MotivoFilaImportacion,
  archivado?: boolean,
): string {
  return motivo === "duplicado" && archivado
    ? MOTIVO_DUPLICADO_ARCHIVADO
    : MOTIVOS_FILA[motivo];
}

/** Mensaje visible de un error de la importación (nunca el cuerpo de la respuesta). */
export function mensajeDeErrorImportacion(
  status: number,
  datos: unknown,
): string {
  if (status === 413) return MENSAJES_IMPORTACION.archivoGrande;
  if (status === 403) return MENSAJES.sinPermiso;
  if (status === 400) {
    const codigo = (datos as { codigo?: string } | null)?.codigo;
    if (codigo === "archivo_invalido")
      return MENSAJES_IMPORTACION.archivoInvalido;
    if (codigo === "columnas_faltantes")
      return MENSAJES_IMPORTACION.columnasFaltantes;
    if (codigo === "demasiadas_filas")
      return MENSAJES_IMPORTACION.demasiadasFilas;
  }
  return MENSAJES.errorGeneral;
}

export type ResultadoImportacion<T> =
  { ok: true; datos: T } | { ok: false; mensaje: string };

async function enviar<T>(
  ruta: string,
  archivo: Blob,
  esquema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
): Promise<ResultadoImportacion<T>> {
  const r = await api(`/clientes/importacion/${ruta}`, {
    method: "POST",
    cuerpoCrudo: archivo,
  });
  if (!r.ok)
    return { ok: false, mensaje: mensajeDeErrorImportacion(r.status, r.datos) };
  const analizado = esquema.safeParse(r.datos);
  if (!analizado.success || analizado.data === undefined)
    return { ok: false, mensaje: MENSAJES.errorGeneral };
  return { ok: true, datos: analizado.data };
}

export const revisarArchivo = (
  archivo: Blob,
): Promise<ResultadoImportacion<VistaPrevia>> =>
  enviar("vista-previa", archivo, vistaPreviaSchema);

export const confirmarImportacion = (
  archivo: Blob,
): Promise<ResultadoImportacion<InformeImportacion>> =>
  enviar("confirmar", archivo, informeImportacionSchema);
