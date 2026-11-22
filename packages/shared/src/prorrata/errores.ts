import { z } from "zod";

// Spec 026 (D-5). Códigos nuevos: `mes_cambiado`, `mes_declarado` y `prorrata_declarada` (409), `periodo_futuro` (400).
// Se reutilizan `cliente_archivado`, `credencial_no_configurada`, `credencial_invalida`, `solicitud_invalida`,
// `no_encontrado` y `permiso_denegado`. El cuerpo es solo `{codigo}`: sin montos ni RUC (D-7).
export const CODIGOS_ERROR_PRORRATA = ["mes_cambiado", "mes_declarado", "prorrata_declarada", "periodo_futuro"] as const;
export type CodigoErrorProrrata = (typeof CODIGOS_ERROR_PRORRATA)[number];
export const errorProrrataSchema = z.object({ codigo: z.enum(CODIGOS_ERROR_PRORRATA) });
export type ErrorProrrata = z.infer<typeof errorProrrataSchema>;
