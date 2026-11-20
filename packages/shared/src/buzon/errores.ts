import { z } from "zod";

// Spec 023 (D-6, D-10). Códigos de error de revisar y abrir: 409 los tres primeros, 429 `captura_reciente` (con Retry-After).
// Spec 024: `atencion_cambiada` (409, otra persona cambió el estado), `comentario_requerido` y `cursor_invalido` (400).
export const CODIGOS_ERROR_BUZON = [
  "cliente_archivado",
  "credencial_no_configurada",
  "credencial_invalida",
  "captura_reciente",
  "atencion_cambiada",
  "comentario_requerido",
  "cursor_invalido",
] as const;
export type CodigoErrorBuzon = (typeof CODIGOS_ERROR_BUZON)[number];

/** El cuerpo es solo `{codigo}`: nunca datos del cliente ni de la credencial. */
export const errorBuzonSchema = z.object({ codigo: z.enum(CODIGOS_ERROR_BUZON) });
export type ErrorBuzon = z.infer<typeof errorBuzonSchema>;
