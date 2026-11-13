import { z } from "zod";

// Spec 021 (D-5, P-2). `regla_cambiada` es 409 (versionBase vieja) y `proveedores_distintos` es 422 («Recordar» con más de
// un proveedor). El cuerpo es solo `{codigo}`: sin datos (D-10).
export const CODIGOS_ERROR_REGLA = ["regla_cambiada", "proveedores_distintos"] as const;
export type CodigoErrorRegla = (typeof CODIGOS_ERROR_REGLA)[number];
export const errorReglaSchema = z.object({ codigo: z.enum(CODIGOS_ERROR_REGLA) });
export type ErrorRegla = z.infer<typeof errorReglaSchema>;
