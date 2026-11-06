import { z } from "zod";
import { destinoCompraSchema, MOTIVO_EXCLUSION_MAX, reglaCompraSchema, versionBaseSchema } from "./esquemas.js";

// Spec 014 (D-15, DU-5, DU-6). Las masivas llevan hasta 5.000 filas explícitas, cada una con su versionBase.
// Son parciales: el servicio aplica las válidas y responde con las rechazadas.

export const MAX_ITEMS_MASIVA = 5000;

const itemMasivaSchema = z.object({ compraId: z.uuid(), versionBase: versionBaseSchema });
export type ItemMasiva = z.infer<typeof itemMasivaSchema>;

/** De 1 a 5.000 filas, sin `compraId` repetido (aunque cambie el versionBase). */
const itemsSchema = z
  .array(itemMasivaSchema)
  .min(1)
  .max(MAX_ITEMS_MASIVA)
  .superRefine((items, ctx) => {
    const vistos = new Set<string>();
    for (const [i, item] of items.entries()) {
      const id = item.compraId.toLowerCase();
      if (vistos.has(id)) {
        ctx.addIssue({ code: "custom", path: [i, "compraId"], message: "compraId repetido" });
        return;
      }
      vistos.add(id);
    }
  });

export const masivaClasificarSchema = z.object({ items: itemsSchema, destino: destinoCompraSchema });
export type MasivaClasificar = z.infer<typeof masivaClasificarSchema>;

/** Sin `confirmar` ni `dato`: en masa solo se aceptan las sugerencias que no los piden. */
export const masivaAceptarSchema = z.object({ items: itemsSchema, regla: reglaCompraSchema });
export type MasivaAceptar = z.infer<typeof masivaAceptarSchema>;

export const masivaExcluirSchema = z.object({ items: itemsSchema, motivo: z.string().max(MOTIVO_EXCLUSION_MAX).optional() });
export type MasivaExcluir = z.infer<typeof masivaExcluirSchema>;

export const masivaRestaurarSchema = z.object({ items: itemsSchema });
export type MasivaRestaurar = z.infer<typeof masivaRestaurarSchema>;
