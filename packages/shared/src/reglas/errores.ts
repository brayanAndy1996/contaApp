import { z } from "zod";

// Spec 021 (D-5, P-2). `regla_cambiada` es 409 (versionBase vieja); `proveedores_distintos` y `periodos_distintos` son 422
// («Recordar» con más de un proveedor o con compras de más de un periodo, H-021-1-1). `importacion_en_curso` es 409 (025: ya hay una importación del historial en curso para el cliente). El cuerpo es solo `{codigo}`: sin datos (D-10).
export const CODIGOS_ERROR_REGLA = ["regla_cambiada", "proveedores_distintos", "periodos_distintos", "importacion_en_curso"] as const;
export type CodigoErrorRegla = (typeof CODIGOS_ERROR_REGLA)[number];
export const errorReglaSchema = z.object({ codigo: z.enum(CODIGOS_ERROR_REGLA) });
export type ErrorRegla = z.infer<typeof errorReglaSchema>;
