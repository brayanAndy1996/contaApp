import { z } from "zod";
import {
  destinoCompraSchema,
  identidadCompraSchema,
  MONEDAS_COMPRA,
  montosColumnasSchema,
  proveedorCompraSchema,
  tipoCambioSchema,
} from "../compras/esquemas.js";
import { itemsXmlSchema } from "./detalle.js";

// Spec 016 · agregar desde XML (plan, Contratos: HTTP; P-9).

/**
 * Query de `POST /desde-xml`. El destino lo elige el usuario. El tipo de cambio es opcional aquí: el esquema no conoce la
 * moneda del XML, y el servicio lo valida con `agregarCompraSchema` (USD lo exige, PEN lo prohíbe). Un tenantId o clienteId
 * de la query se descarta.
 */
export const destinoDesdeXmlSchema = z.object({
  destino: destinoCompraSchema,
  tipoCambio: tipoCambioSchema.optional(),
});
export type DestinoDesdeXml = z.infer<typeof destinoDesdeXmlSchema>;

/**
 * Vista previa del alta desde un XML (no escribe nada). No trae tipo de cambio ni destino: los pone el usuario. En USD
 * `requiereTipoCambio` es `true` (P-9). `existente` apunta a la compra ya registrada con esa identidad (CA-13).
 */
export const vistaPreviaDesdeXmlSchema = identidadCompraSchema
  .extend({
    proveedor: proveedorCompraSchema,
    fecha: z.iso.date(),
    moneda: z.enum(MONEDAS_COMPRA),
    montos: montosColumnasSchema,
    items: itemsXmlSchema,
    existente: z.object({ id: z.uuid() }).nullable(),
    requiereTipoCambio: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.requiereTipoCambio !== (v.moneda === "USD")) {
      ctx.addIssue({
        code: "custom",
        path: ["requiereTipoCambio"],
        message: "requiereTipoCambio debe ser true solo en USD",
      });
    }
  });
export type VistaPreviaDesdeXml = z.infer<typeof vistaPreviaDesdeXmlSchema>;
