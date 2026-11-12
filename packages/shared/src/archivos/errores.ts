import { z } from "zod";

// Spec 012b (plan, Contratos: HTTP). Códigos `{codigo}` de error de archivos y de excluir/restaurar ventas.
// `solicitud_invalida` y los 403/404 genéricos no se repiten aquí: ya existen en 005/007.

export const CODIGOS_ERROR_ARCHIVO = [
  "prevalidacion_fallida",
  "formato_no_oficial",
  "resumen_cambiado",
  "estado_invalido",
  "periodo_generado",
  "periodo_revisado",
  "cliente_archivado",
  "archivo_alterado",
  "no_excluible",
  "ya_excluida",
  "no_excluida",
  "resumen_fuera_de_rango",
] as const;
export type CodigoErrorArchivo = (typeof CODIGOS_ERROR_ARCHIVO)[number];
export const codigoErrorArchivoSchema = z.enum(CODIGOS_ERROR_ARCHIVO);
