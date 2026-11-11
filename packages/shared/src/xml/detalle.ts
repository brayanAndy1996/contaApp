import { z } from "zod";
import { autorSchema } from "../autor.js";
import {
  MONEDAS_COMPRA,
  montoDecimalSchema,
  reglaCompraSchema,
  tipoCambioSchema,
} from "../compras/esquemas.js";
import { hallazgoVistaSchema } from "../compras/respuestas.js";
import { origenDocumentoXmlSchema } from "./origen-documento.js";

// Spec 016 (plan, Contratos: HTTP y `DetalleCompraDto`). El de 014 (`detalleCompraSchema`, GET /:compraId) ya existe en
// `compras/respuestas.ts`; el de la lupa se llama `detalleLupaSchema`. Los montos viajan como cadenas decimales:
// ningún esquema acepta un `number` para dinero. `z.object` descarta claves desconocidas (tenantId, ruta de storage, hash).

/** Tope de ítems que lee el parser (D-1); el detalle y la vista previa no admiten más. */
export const MAX_ITEMS_XML = 2000;
export const GLOSA_XML_MAX = 500;
export const HISTORIAL_PROVEEDOR_MAX = 50;

/** Cantidad y precio unitario conservan el texto exacto del XML (hasta 10 decimales): no son NUMERIC(14,2). */
const decimalExactoSchema = z
  .string()
  .max(32)
  .regex(/^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,10})?$/);

export const itemXmlSchema = z.object({
  descripcion: z.string().max(GLOSA_XML_MAX),
  cantidad: decimalExactoSchema,
  unidad: z.string().max(10),
  precioUnitario: decimalExactoSchema,
  valor: montoDecimalSchema,
  afectacion: z.string().max(10),
  igv: montoDecimalSchema,
  isc: montoDecimalSchema,
  icbper: montoDecimalSchema,
});
export type ItemXml = z.infer<typeof itemXmlSchema>;

export const itemsXmlSchema = z.array(itemXmlSchema).max(MAX_ITEMS_XML);

const monedaSchema = z.enum(MONEDAS_COMPRA);

export const cabeceraLupaSchema = z.object({
  ruc: z.string().min(1).max(15),
  razonSocial: z.string().max(200).nullable(),
  proveedorNuevo: z.boolean(),
  tipo: z.string().regex(/^[0-9]{2}$/),
  serie: z.string().min(1).max(10),
  numero: z.string().min(1).max(20),
  fecha: z.iso.date(),
  moneda: monedaSchema,
  tipoCambio: tipoCambioSchema.nullable(),
  origenSerie: z.enum(["E", "F"]).nullable(),
});
export type CabeceraLupa = z.infer<typeof cabeceraLupaSchema>;

/** Columnas que se comparan SIRE contra XML (D-9). */
export const COLUMNAS_COMPARACION = ["bi", "igv", "noGravado", "isc", "icbper", "otrosTributos", "total"] as const;
export type ColumnaComparacion = (typeof COLUMNAS_COMPARACION)[number];

export const comparacionFilaSchema = z.object({
  columna: z.enum(COLUMNAS_COMPARACION),
  sire: montoDecimalSchema,
  /** `null` cuando el comprobante no tiene XML. */
  xml: montoDecimalSchema.nullable(),
  difiere: z.boolean(),
  regla: reglaCompraSchema.optional(),
  explicacion: z.string().optional(),
});
export type ComparacionFila = z.infer<typeof comparacionFilaSchema>;

export const historialProveedorFilaSchema = z.object({
  periodo: z.string().regex(/^[0-9]{4}(0[1-9]|1[0-2])$/),
  serie: z.string().min(1).max(10),
  numero: z.string().min(1).max(20),
  biDg: montoDecimalSchema,
  biDgng: montoDecimalSchema,
  biDng: montoDecimalSchema,
  excluida: z.boolean(),
});
export type HistorialProveedorFila = z.infer<typeof historialProveedorFilaSchema>;

export const CODIGOS_XML_NO_DISPONIBLE = ["no_encontrado", "credencial", "transitorio", "no_aplica"] as const;
export type CodigoXmlNoDisponible = (typeof CODIGOS_XML_NO_DISPONIBLE)[number];

/** Aviso cuando la moneda del XML no es la de la fila (CA-9). */
export const avisoMonedaSchema = z.object({ monedaXml: monedaSchema, monedaFila: monedaSchema });
export type AvisoMoneda = z.infer<typeof avisoMonedaSchema>;

export const estadoXmlSchema = z.discriminatedUnion("estado", [
  z.object({
    estado: z.literal("disponible"),
    origen: origenDocumentoXmlSchema,
    subidoPor: z.uuid().optional(),
    autor: autorSchema.optional(),
    subidoEn: z.iso.datetime().optional(),
    avisoMoneda: avisoMonedaSchema.optional(),
  }),
  z.object({ estado: z.literal("pendiente") }),
  z.object({ estado: z.literal("sin_solicitar") }),
  z.object({ estado: z.literal("no_disponible"), codigo: z.enum(CODIGOS_XML_NO_DISPONIBLE) }),
]);
export type EstadoXml = z.infer<typeof estadoXmlSchema>;

export const detalleLupaSchema = z.object({
  cabecera: cabeceraLupaSchema,
  items: itemsXmlSchema,
  comparacion: z.array(comparacionFilaSchema),
  hallazgos: z.array(hallazgoVistaSchema),
  historialProveedor: z.array(historialProveedorFilaSchema).max(HISTORIAL_PROVEEDOR_MAX),
  xml: estadoXmlSchema,
});
export type DetalleLupa = z.infer<typeof detalleLupaSchema>;
