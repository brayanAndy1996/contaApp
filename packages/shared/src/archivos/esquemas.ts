import { z } from "zod";

// Spec 012b (plan, Contratos: HTTP). Cuerpo de `POST …/archivos`. `libro` sale de la ruta; el registro y el permiso del
// formato provisional los decide el servidor. Estricto: cualquier clave extra se rechaza (no se descarta).

/** sha256 en hexadecimal minúscula (64 caracteres). */
export const HUELLA_HEX = /^[0-9a-f]{64}$/;
export const sha256HexSchema = z.string().regex(HUELLA_HEX);

export const ESTADOS_VISTOS_GENERAR = ["abierto", "revisado"] as const;

export const generarArchivoSchema = z.strictObject({
  estadoVisto: z.enum(ESTADOS_VISTOS_GENERAR),
  huella: sha256HexSchema,
});
export type GenerarArchivo = z.infer<typeof generarArchivoSchema>;
