import { z } from "zod";
import { sinControles } from "./esquemas.js";

// Spec 014 (D-13). Query string de GET …/compras: todo llega como texto y aquí se convierte. Los booleanos
// no usan `coerce`: "false" no puede dar true.

export const VISTAS_COMPRAS = ["con_igv", "sin_igv", "excluidas"] as const;
export type VistaCompras = (typeof VISTAS_COMPRAS)[number];

export const LIMITE_MAX_LISTADO = 5000;
export const CURSOR_MAX = 1024;
export const BUSQUEDA_MAX = 100;

const limiteSchema = z
  .union([z.number(), z.string().regex(/^[0-9]{1,5}$/).transform((s) => Number(s))])
  .pipe(z.number().int().min(1).max(LIMITE_MAX_LISTADO));

const booleanoSchema = z.union([z.boolean(), z.enum(["true", "false"]).transform((s) => s === "true")]);

export const listarComprasSchema = z.object({
  /** Opaco: el esquema no lo interpreta; decodificarlo y rechazar uno mal formado es del servicio. */
  cursor: z.string().min(1).max(CURSOR_MAX).optional(),
  limite: limiteSchema.optional(),
  vista: z.enum(VISTAS_COMPRAS).optional(),
  alertas: booleanoSchema.optional(),
  proveedorNuevo: booleanoSchema.optional(),
  /** Prefijo de RUC, fragmento de razón social o serie-número. Los comodines los escapa el repositorio. */
  q: z.string().max(BUSQUEDA_MAX).refine(sinControles).optional(),
});
export type ListarCompras = z.infer<typeof listarComprasSchema>;
