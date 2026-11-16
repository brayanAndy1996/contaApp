import { z } from "zod";
import { autorSchema } from "../autor.js";
import { destinoCompraSchema, versionBaseSchema } from "../compras/esquemas.js";
import { codigoReglaMotorSchema } from "./esquemas.js";

// Spec 021 (plan, Contratos: HTTP; CA-7, CA-8, CA-13). El único dato de RUC viaja dentro de `proveedor`.

const entero = z.number().int().min(0);

export const reglaVistaSchema = z.object({
  id: z.uuid(),
  proveedor: z.object({ tipo: z.string(), numero: z.string(), razonSocial: z.string().nullable() }),
  destino: destinoCompraSchema,
  activa: z.boolean(),
  version: versionBaseSchema,
  /** AAAAMM */
  periodoAprendido: z.string().regex(/^[0-9]{4}(0[1-9]|1[0-2])$/),
  aplicada: entero,
  aceptada: entero,
  creadaPor: autorSchema.nullable(),
  creadaEn: z.iso.datetime(),
  actualizadaEn: z.iso.datetime(),
});
export type ReglaVista = z.infer<typeof reglaVistaSchema>;

/** GET /estudio/reglas-motor */
export const reglasMotorSchema = z.object({
  reglas: z.array(z.object({ codigo: codigoReglaMotorSchema, descripcion: z.string(), activa: z.boolean() })),
  aportarCatalogo: z.boolean(),
});
export type ReglasMotor = z.infer<typeof reglasMotorSchema>;
