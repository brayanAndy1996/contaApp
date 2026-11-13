import { z } from "zod";
import { destinoCompraSchema, versionBaseSchema } from "../compras/esquemas.js";
import { MAX_ITEMS_MASIVA } from "../compras/masivas.js";

// Spec 021 (plan, Contratos: HTTP; D-5, P-2, P-8, P-10). Cuerpos y query strings de las rutas de reglas aprendidas.
// `z.object` descarta las claves desconocidas: clienteId, tenantId, proveedor y ruc nunca viajan por el cuerpo.

/** Códigos de las reglas del motor que el estudio puede apagar (RF-089). La prevalidación de 012 no figura (P-8). */
export const CODIGOS_REGLA_MOTOR = ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS"] as const;
export type CodigoReglaMotor = (typeof CODIGOS_REGLA_MOTOR)[number];
export const codigoReglaMotorSchema = z.enum(CODIGOS_REGLA_MOTOR);

/** «Recordar» (POST …/reglas/recordar): de 1 a 5.000 compras sin repetir; `versionBase` null crea la regla y un entero actualiza la viva. */
export const recordarReglaSchema = z.object({
  compraIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_ITEMS_MASIVA)
    .superRefine((ids, ctx) => {
      const vistos = new Set<string>();
      for (const [i, id] of ids.entries()) {
        const k = id.toLowerCase();
        if (vistos.has(k)) {
          ctx.addIssue({ code: "custom", path: [i], message: "compraId repetido" });
          return;
        }
        vistos.add(k);
      }
    }),
  destino: destinoCompraSchema,
  versionBase: versionBaseSchema.nullable(),
});
export type RecordarRegla = z.infer<typeof recordarReglaSchema>;

/** PATCH …/reglas/:reglaId: al menos uno de `destino` o `activa`. */
export const editarReglaSchema = z
  .object({ versionBase: versionBaseSchema, destino: destinoCompraSchema.optional(), activa: z.boolean().optional() })
  .refine((v) => v.destino !== undefined || v.activa !== undefined, { message: "Se requiere destino o activa" });
export type EditarRegla = z.infer<typeof editarReglaSchema>;

/** DELETE …/reglas/:reglaId: `versionBase` llega en el query string (texto) o como número. */
export const eliminarReglaSchema = z.object({
  versionBase: z
    .union([z.number(), z.string().regex(/^[0-9]{1,9}$/).transform((s) => Number(s))])
    .pipe(versionBaseSchema),
});
export type EliminarRegla = z.infer<typeof eliminarReglaSchema>;

/** PUT /estudio/reglas-motor/:codigo */
export const fijarReglaMotorSchema = z.object({ activa: z.boolean() });
export type FijarReglaMotor = z.infer<typeof fijarReglaMotorSchema>;

/** PUT /estudio/reglas-motor/aporte */
export const fijarAporteSchema = z.object({ aportar: z.boolean() });
export type FijarAporte = z.infer<typeof fijarAporteSchema>;
