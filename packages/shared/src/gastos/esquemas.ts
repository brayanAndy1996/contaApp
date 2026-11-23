import { z } from "zod";

// Spec 027 (plan, Contratos: shared; R-4, R-7, R-11, R-13; D-3). Cuerpos de las solicitudes del diccionario de gastos no
// deducibles. Todos los objetos son `.strict()`: el estudio y el cliente salen de la sesión y la ruta, nunca del cuerpo.
// `shared` no depende de `domain`: la lista de categorías se repite aquí (la guarda `esquemas-027.spec.ts`).

/** Las seis categorías de gasto no deducible, en este orden (códigos de 011). */
export const CATEGORIAS_GND = [
  "calzado-ropa",
  "juguetes",
  "entretenimiento",
  "alimentos-personales",
  "cuidado-personal",
  "utiles-escolares",
] as const;
export type CategoriaGnd = (typeof CATEGORIAS_GND)[number];
export const categoriaGndSchema = z.enum(CATEGORIAS_GND);

/** Límite de palabras propias activas por estudio. */
export const LIMITE_PALABRAS_PROPIAS = 2000;
/** Hasta 5 excepciones por palabra; cada una, de 1 a 3 palabras. */
export const MAX_EXCEPCIONES = 5;
export const MAX_TERMINOS_APRENDER = 10;

const PALABRA = String.raw`[\p{L}\p{Nd}\p{M}]+`;
const RE_PALABRA = /^[\p{L}\p{Nd}\p{M}]{3,40}$/u;
const RE_FRASE = new RegExp(String.raw`^${PALABRA}( ${PALABRA}){0,2}$`, "u");

/** Una palabra de letras y dígitos (3 a 40), sin espacios ni signos. No transforma: el backend normaliza con el dominio. */
export const palabraSchema = z.string().regex(RE_PALABRA);

/** Una frase de excepción: de 1 a 3 palabras de letras y dígitos separadas por un espacio. */
export const fraseExcepcionSchema = z.string().max(120).regex(RE_FRASE);

/** Hasta 5 frases de excepción (puede ser vacía). */
export const excepcionesSchema = z
  .array(fraseExcepcionSchema)
  .max(MAX_EXCEPCIONES);

const version0 = z.number().int().min(0);
const version1 = z.number().int().min(1);

/** POST …/palabras (estudio) y POST /plataforma/diccionario (super-admin). */
export const agregarPalabraSchema = z
  .object({
    palabra: palabraSchema,
    categoria: categoriaGndSchema,
    excepciones: excepcionesSchema.optional(),
  })
  .strict();
export type AgregarPalabra = z.infer<typeof agregarPalabraSchema>;

/** PUT …/palabras/:id: activar o desactivar una palabra propia. */
export const estadoPalabraSchema = z
  .object({ activa: z.boolean(), version: version1 })
  .strict();
export type EstadoPalabra = z.infer<typeof estadoPalabraSchema>;

/** PUT …/globales/:id: desactivar o reactivar una global para el estudio (no versiona). */
export const estadoGlobalSchema = z.object({ activa: z.boolean() }).strict();
export type EstadoGlobal = z.infer<typeof estadoGlobalSchema>;

/** PUT …/umbral: 1 a 20; `version` 0 = el estudio aún no tiene fila (umbral por defecto 3). */
export const umbralSchema = z
  .object({ umbral: z.number().int().min(1).max(20), version: version0 })
  .strict();
export type CambiarUmbral = z.infer<typeof umbralSchema>;

/** PUT /clientes/:clienteId/gastos/categorias: subconjuntos de las seis, disjuntos y sin repetidos. */
export const categoriasClienteSchema = z
  .object({
    permitidas: z.array(categoriaGndSchema),
    quitadas: z.array(categoriaGndSchema),
    version: version0,
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.permitidas).size === v.permitidas.length &&
      new Set(v.quitadas).size === v.quitadas.length,
    { message: "categorías repetidas" },
  )
  .refine((v) => !v.permitidas.some((c) => v.quitadas.includes(c)), {
    message: "permitidas y quitadas no son disjuntas",
  });
export type CategoriasCliente = z.infer<typeof categoriasClienteSchema>;

/** POST …/gastos/aprender/:compraId: de 1 a 10 términos con su categoría (obligatoria) y, si aplica, sus frases de excepción. */
export const aprenderSchema = z
  .object({
    terminos: z
      .array(
        z
          .object({
            termino: palabraSchema,
            categoria: categoriaGndSchema,
            excepciones: excepcionesSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TERMINOS_APRENDER),
  })
  .strict();
export type Aprender = z.infer<typeof aprenderSchema>;

/** POST /plataforma/diccionario: el mismo cuerpo que agregar una palabra propia. */
export const palabraGlobalSchema = agregarPalabraSchema;
export type PalabraGlobal = AgregarPalabra;

/** PUT /plataforma/diccionario/:id: todo obligatorio; la palabra no se renombra. */
export const editarGlobalSchema = z
  .object({
    categoria: categoriaGndSchema,
    excepciones: excepcionesSchema,
    activa: z.boolean(),
    version: version1,
  })
  .strict();
export type EditarGlobal = z.infer<typeof editarGlobalSchema>;
