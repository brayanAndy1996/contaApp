import { z } from "zod";
import { autorSchema } from "../autor.js";
import {
  categoriaGndSchema,
  LIMITE_PALABRAS_PROPIAS,
  MAX_EXCEPCIONES,
  MAX_TERMINOS_APRENDER,
} from "./esquemas.js";

// Spec 027 (plan, Contratos: shared). Vistas de respuesta del diccionario, las categorías del cliente y el historial global.
// Ninguna lleva glosas ni texto del XML (R-5): solo palabras del diccionario, términos propuestos y conteos.

const fechaIso = z.iso.datetime();
const entero0 = z.number().int().min(0);
const excepciones = z.array(z.string()).max(MAX_EXCEPCIONES);
const palabrasCortas = z.array(z.string()).max(MAX_TERMINOS_APRENDER);

export const palabraGlobalVistaSchema = z.object({
  id: z.uuid(),
  palabra: z.string(),
  categoria: categoriaGndSchema,
  excepciones,
  desactivadaPorEstudio: z.boolean(),
});
export type PalabraGlobalVista = z.infer<typeof palabraGlobalVistaSchema>;

export const palabraPropiaVistaSchema = z.object({
  id: z.uuid(),
  palabra: z.string(),
  categoria: categoriaGndSchema,
  excepciones,
  origen: z.enum(["manual", "aprendida"]),
  activa: z.boolean(),
  version: z.number().int().min(1),
  autor: autorSchema,
  compraOrigenId: z.uuid().nullable(),
  creadaEn: fechaIso,
});
export type PalabraPropiaVista = z.infer<typeof palabraPropiaVistaSchema>;

/** GET /estudio/reglas-motor/gastos. */
export const gastosEstudioVistaSchema = z.object({
  umbral: z.number().int().min(1).max(20),
  versionUmbral: entero0,
  activasPropias: entero0,
  limitePropias: z.literal(LIMITE_PALABRAS_PROPIAS),
  globales: z.array(palabraGlobalVistaSchema),
  propias: z.array(palabraPropiaVistaSchema),
});
export type GastosEstudioVista = z.infer<typeof gastosEstudioVistaSchema>;

/** GET /clientes/:clienteId/gastos/categorias. */
export const categoriasClienteVistaSchema = z.object({
  ciiu: z
    .string()
    .regex(/^[0-9]{4}$/)
    .nullable(),
  seccion: z
    .string()
    .regex(/^[A-U]$/)
    .nullable(),
  base: z.array(categoriaGndSchema),
  permitidas: z.array(categoriaGndSchema),
  quitadas: z.array(categoriaGndSchema),
  efectivas: z.array(categoriaGndSchema),
  version: entero0,
});
export type CategoriasClienteVista = z.infer<
  typeof categoriasClienteVistaSchema
>;

/**
 * GET …/gastos/aprender/:compraId: términos propuestos (0 a 10) y, solo para los que tienen, sus frases de excepción
 * sugeridas (H-027-2-3: «medias» → «media pulgada»). La clave `excepciones` falta si ningún término las tiene.
 */
export const propuestaAprenderVistaSchema = z.object({
  terminos: palabrasCortas,
  excepciones: z
    .record(z.string(), z.array(z.string()).min(1).max(MAX_EXCEPCIONES))
    .optional(),
});
export type PropuestaAprenderVista = z.infer<
  typeof propuestaAprenderVistaSchema
>;

/** POST …/gastos/aprender/:compraId: palabras normalizadas guardadas y omitidas (ya existían). */
export const aprenderRespuestaSchema = z.object({
  guardadas: palabrasCortas,
  omitidas: palabrasCortas,
});
export type AprenderRespuesta = z.infer<typeof aprenderRespuestaSchema>;

/** GET /plataforma/diccionario. */
export const diccionarioGlobalVistaSchema = z.object({
  palabras: z.array(
    z.object({
      id: z.uuid(),
      palabra: z.string(),
      categoria: categoriaGndSchema,
      excepciones,
      activa: z.boolean(),
      version: z.number().int().min(1),
      actualizadaEn: fechaIso,
    }),
  ),
});
export type DiccionarioGlobalVista = z.infer<
  typeof diccionarioGlobalVistaSchema
>;

const cambioGlobal = z.record(z.string(), z.unknown());

/** GET /plataforma/diccionario/historial: paginado por fecha (`siguiente` es el `antes` de la página que sigue). */
export const historialGlobalVistaSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      palabraGlobalId: z.uuid(),
      palabra: z.string(),
      accion: z.enum(["agregada", "editada"]),
      antes: cambioGlobal.nullable(),
      despues: cambioGlobal,
      autor: autorSchema,
      ocurridaEn: fechaIso,
    }),
  ),
  siguiente: fechaIso.nullable(),
});
export type HistorialGlobalVista = z.infer<typeof historialGlobalVistaSchema>;
