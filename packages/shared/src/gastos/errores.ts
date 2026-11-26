import { z } from "zod";

// Spec 027 (plan, Contratos: shared; mapeo de SQLSTATE). Códigos nuevos: `version_cambiada`, `palabra_existente`,
// `limite_palabras`, `compra_no_excluida`, `compra_sin_xml` y `periodo_no_abierto` (409). Se reutilizan `cliente_archivado`,
// `solicitud_invalida`, `no_encontrado` y `permiso_denegado`. El cuerpo es solo `{codigo}`: sin palabras ni glosas.
export const CODIGOS_ERROR_GASTOS = [
  "version_cambiada",
  "palabra_existente",
  "limite_palabras",
  "compra_no_excluida",
  "compra_sin_xml",
  "periodo_no_abierto",
] as const;
export type CodigoErrorGastos = (typeof CODIGOS_ERROR_GASTOS)[number];
export const errorGastosSchema = z.object({
  codigo: z.enum(CODIGOS_ERROR_GASTOS),
});
export type ErrorGastos = z.infer<typeof errorGastosSchema>;
