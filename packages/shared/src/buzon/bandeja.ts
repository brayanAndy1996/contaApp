import { z } from "zod";
import { CATEGORIAS_BUZON, LIMITE_MAX_MENSAJES_BUZON } from "./esquemas.js";
import { FILTROS_ATENCION, atencionFilaSchema } from "./atencion.js";
import { estadoBuzonSchema, mensajeBuzonFilaSchema } from "./respuestas.js";

// Spec 024 (plan: Contratos: shared; D-2 a D-4, D-7, D-9, D-12; CA-2, CA-4, CA-8). Bandeja de buzones.

/** AAAA-MM-DD que existe en el calendario (días de Lima). */
const fechaDia = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const [a, m, d] = s.split("-").map(Number) as [number, number, number];
    const f = new Date(Date.UTC(a, m - 1, d));
    return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
  }, { message: "fecha inválida" });

const limiteQuery = z.preprocess(
  (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
  z.number().int().min(1).max(LIMITE_MAX_MENSAJES_BUZON).optional(),
);

const formaFiltrosCliente = {
  categoria: z.enum([...CATEGORIAS_BUZON, "criticos"]).optional(),
  leido: z.enum(["si", "no"]).optional(),
  atencion: z.enum(FILTROS_ATENCION).default("todos"),
  desde: fechaDia.optional(),
  hasta: fechaDia.optional(),
  cursor: z.string().min(1).max(256).optional(),
  limite: limiteQuery,
};

const desdeAntesDeHasta = (f: { desde?: string | undefined; hasta?: string | undefined }) =>
  f.desde === undefined || f.hasta === undefined || f.desde <= f.hasta;
const OPCION_FECHAS = { message: "desde posterior a hasta", path: ["desde"] };

/** `GET /buzon/mensajes`: parámetro desconocido o repetido = 400 (D-3). */
export const filtrosBandejaSchema = z
  .object({
    responsable: z.literal("yo").optional(),
    ...formaFiltrosCliente,
    archivados: z.literal("1").optional(),
  })
  .strict()
  .refine(desdeAntesDeHasta, OPCION_FECHAS);
export type FiltrosBandeja = z.infer<typeof filtrosBandejaSchema>;

/** `GET /clientes/:clienteId/buzon/mensajes`: el cliente ya viene fijado por la ruta. */
export const filtrosBandejaClienteSchema = z
  .object(formaFiltrosCliente)
  .strict()
  .refine(desdeAntesDeHasta, OPCION_FECHAS);
export type FiltrosBandejaCliente = z.infer<typeof filtrosBandejaClienteSchema>;

/** Fila de 023 + cliente + atención. Nunca RUC, tenantId ni comentario. */
export const filaBandejaSchema = mensajeBuzonFilaSchema.extend({
  cliente: z.object({ id: z.uuid(), razonSocial: z.string(), archivado: z.boolean() }),
  atencion: atencionFilaSchema,
});
export type FilaBandeja = z.infer<typeof filaBandejaSchema>;

export const respuestaBandejaSchema = z.object({
  mensajes: z.array(filaBandejaSchema).max(LIMITE_MAX_MENSAJES_BUZON),
  siguiente: z.string().min(1).nullable(),
});
export type RespuestaBandeja = z.infer<typeof respuestaBandejaSchema>;

/** Ruta del cliente (023): la página lleva ahora filas de bandeja. */
export const paginaMensajesBuzonSchema = z.object({
  estado: estadoBuzonSchema,
  mensajes: z.array(filaBandejaSchema).max(LIMITE_MAX_MENSAJES_BUZON),
  siguiente: z.string().min(1).nullable(),
});
export type PaginaMensajesBuzon = z.infer<typeof paginaMensajesBuzonSchema>;

/** Forma de `ClienteDto.buzon`: pendientes no históricos y, de ellos, los críticos (D-9). */
export const indicadorBuzonSchema = z.object({
  nuevos: z.number().int().min(0),
  criticosNuevos: z.number().int().min(0),
});
export type IndicadorBuzon = z.infer<typeof indicadorBuzonSchema>;
