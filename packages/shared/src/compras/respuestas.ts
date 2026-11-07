import { z } from "zod";
import {
  COLUMNAS_MONTO_COMPRA,
  columnaMontoCompraSchema,
  destinoCompraSchema,
  estadoPeriodoSchema,
  montoDecimalSchema,
  MONEDAS_COMPRA,
  reglaCompraSchema,
  versionBaseSchema,
} from "./esquemas.js";

// Spec 014 (plan, Contratos: HTTP). Formas de las respuestas. `shared` no depende de `domain`: las formas
// repiten las de los tipos de dominio (Money → cadena decimal). Los montos nunca son `number`.

const fechaIso = z.iso.datetime();
const entero = z.number().int().min(0);

/** Las 10 columnas y el total, todos cadenas decimales. */
export const montosCompraSchema = z.object({
  biDg: montoDecimalSchema,
  igvDg: montoDecimalSchema,
  biDgng: montoDecimalSchema,
  igvDgng: montoDecimalSchema,
  biDng: montoDecimalSchema,
  igvDng: montoDecimalSchema,
  noGravado: montoDecimalSchema,
  isc: montoDecimalSchema,
  icbper: montoDecimalSchema,
  otrosTributos: montoDecimalSchema,
  total: montoDecimalSchema,
});
export type MontosCompra = z.infer<typeof montosCompraSchema>;

/** Cuadre por celda: una por columna de IGV, con su explicación si no cuadra (D-5, HU-16). */
export const celdaCuadreSchema = z.object({
  columna: columnaMontoCompraSchema,
  cuadra: z.boolean(),
  explicacion: z.string().nullable(),
});
export type CeldaCuadre = z.infer<typeof celdaCuadreSchema>;

export const cuadreCompraSchema = z.object({ cuadra: z.boolean(), celdas: z.array(celdaCuadreSchema) });
export type CuadreCompra = z.infer<typeof cuadreCompraSchema>;

const montosParcialesSchema = z.partialRecord(z.enum([...COLUMNAS_MONTO_COMPRA, "total"]), montoDecimalSchema);

/** La sugerencia de 011 con sus montos como cadenas. */
export const sugerenciaVistaSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("mover"), origen: columnaMontoCompraSchema, destino: columnaMontoCompraSchema, monto: montoDecimalSchema }),
  z.object({
    tipo: z.literal("separar"),
    columnaBi: columnaMontoCompraSchema,
    min: montoDecimalSchema,
    max: montoDecimalSchema,
    estimado: montoDecimalSchema,
    exacto: montoDecimalSchema.nullable(),
  }),
  z.object({ tipo: z.literal("ajustar"), valores: montosParcialesSchema }),
  z.object({ tipo: z.literal("clasificar") }),
  z.object({ tipo: z.literal("excluir"), palabra: z.string(), categoria: z.string() }),
]);
export type SugerenciaVista = z.infer<typeof sugerenciaVistaSchema>;

export const hallazgoVistaSchema = z.object({
  regla: reglaCompraSchema,
  destino: destinoCompraSchema.nullable(),
  explicacion: z.string(),
  sugerencia: sugerenciaVistaSchema.nullable(),
  requiereConfirmacion: z.boolean(),
  dato: z.enum(["gravado", "destino"]).nullable(),
  /** `sugerenciaEsMasiva` de dominio: entra en la aceptación en bloque (D-15). */
  masiva: z.boolean(),
});
export type HallazgoVista = z.infer<typeof hallazgoVistaSchema>;

export const ACCIONES_VERSION = [
  "descarga",
  "agregar",
  "clasificar",
  "editar",
  "sugerencia",
  "excluir",
  "restaurar",
  "deshacer",
  "rehacer",
] as const;
export type AccionVersion = (typeof ACCIONES_VERSION)[number];

/** Una versión de la compra (historial). La 1 es la fila tal como la trajo el SIRE. */
export const versionCompraVistaSchema = z.object({
  n: versionBaseSchema,
  accion: z.enum(ACCIONES_VERSION),
  operacionId: z.uuid().nullable(),
  usuarioId: z.uuid().nullable(),
  creadaEn: fechaIso,
  excluida: z.boolean(),
  motivo: z.string().nullable(),
  clasificada: z.boolean(),
  montos: montosCompraSchema,
});
export type VersionCompraVista = z.infer<typeof versionCompraVistaSchema>;

/** Fila de la lista y del detalle (versión vigente). La razón social es texto no confiable: se escapa al mostrar. */
export const filaCompraVistaSchema = z.object({
  id: z.uuid(),
  origen: z.enum(["sire", "agregada"]),
  tipo: z.string(),
  serie: z.string(),
  numero: z.string(),
  proveedor: z.object({ tipo: z.string(), numero: z.string(), razonSocial: z.string().nullable() }),
  fecha: z.iso.date(),
  moneda: z.enum(MONEDAS_COMPRA),
  tipoCambio: z.string().nullable(),
  version: versionBaseSchema,
  montos: montosCompraSchema,
  excluida: z.boolean(),
  motivo: z.string().nullable(),
  clasificada: z.boolean(),
  proveedorNuevo: z.boolean(),
  hallazgos: z.array(hallazgoVistaSchema),
});
export type FilaCompraVista = z.infer<typeof filaCompraVistaSchema>;

/** GET …/compras */
export const listadoComprasSchema = z.object({ filas: z.array(filaCompraVistaSchema), siguiente: z.string().nullable() });
export type ListadoCompras = z.infer<typeof listadoComprasSchema>;

/** GET …/compras/:compraId */
export const detalleCompraSchema = z.object({
  original: versionCompraVistaSchema,
  vigente: filaCompraVistaSchema,
  versiones: z.array(versionCompraVistaSchema),
  hallazgos: z.array(hallazgoVistaSchema),
});
export type DetalleCompra = z.infer<typeof detalleCompraSchema>;

/** Respuesta de clasificar, editar, aceptar sugerencia, excluir, restaurar y agregar. */
export const accionCompraRespuestaSchema = z.object({ fila: filaCompraVistaSchema, cuadre: cuadreCompraSchema });
export type AccionCompraRespuesta = z.infer<typeof accionCompraRespuestaSchema>;

/** POST …/calcular (D-16): sin escribir. */
export const calcularRespuestaSchema = z.object({ total: montoDecimalSchema, cuadre: cuadreCompraSchema });
export type CalcularRespuesta = z.infer<typeof calcularRespuestaSchema>;

const casillerosSchema = montosCompraSchema;

/** GET …/compras/resumen (D-8). */
export const resumenComprasSchema = z.object({
  estado: estadoPeriodoSchema,
  casilleros: z.object({ original: casillerosSchema, vigente: casillerosSchema, diferencia: casillerosSchema }),
  conIgv: z.object({ n: entero, casilleros: casillerosSchema }),
  sinIgv: z.object({ n: entero, casilleros: casillerosSchema }),
  filasSinConvertir: z.array(z.string()),
});
export type ResumenComprasVista = z.infer<typeof resumenComprasSchema>;

export const CODIGOS_RECHAZO_MASIVA = [
  "version_obsoleta",
  "requiere_dato",
  "revisar_de_nuevo",
  "fila_excluida",
  "no_masiva",
  "no_excluida",
  "no_encontrada",
] as const;
export type CodigoRechazoMasiva = (typeof CODIGOS_RECHAZO_MASIVA)[number];

/** Informe de una masiva (D-15): `operacionId` es null si no se aplicó ninguna fila. */
export const informeMasivaSchema = z.object({
  operacionId: z.uuid().nullable(),
  aplicadas: entero,
  rechazadas: z.array(z.object({ compraId: z.uuid(), codigo: z.enum(CODIGOS_RECHAZO_MASIVA) })),
});
export type InformeMasiva = z.infer<typeof informeMasivaSchema>;

/** POST …/deshacer y …/rehacer: la operación creada y los ids de las compras que cambiaron. */
export const deshacerRespuestaSchema = z.object({ operacionId: z.uuid(), filas: z.array(z.uuid()) });
export type DeshacerRespuesta = z.infer<typeof deshacerRespuestaSchema>;

/** Tope de claves del `resultado` del trabajo de descarga (4 KB, DU-13). */
export const CLAVES_MAX = 40;

/**
 * `resultado` del trabajo de descarga, tal como lo deja el procesador común de 013 (D-18): la propuesta creada, cuántas filas
 * se recibieron, cuántas son nuevas, iguales o distintas de lo guardado, hasta 40 claves de las distintas y si la lista se
 * recortó (la completa queda en `propuesta_diferencia`). Sin montos ni razones sociales.
 */
export const informeDescargaSchema = z.object({
  propuestaId: z.uuid(),
  recibidas: entero,
  nuevas: entero,
  iguales: entero,
  distintas: entero,
  claves: z.array(z.string()).max(CLAVES_MAX),
  truncado: z.boolean(),
});
export type InformeDescarga = z.infer<typeof informeDescargaSchema>;

// Cuerpos de error con datos (el resto es solo `{codigo}`).
export const errorVersionObsoletaSchema = z.object({ codigo: z.literal("version_obsoleta"), versionVigente: versionBaseSchema });
export const errorRequiereDatoSchema = z.object({ codigo: z.literal("requiere_dato"), dato: z.enum(["gravado", "destino"]) });
export const errorFilaCambiadaSchema = z.object({ codigo: z.literal("fila_cambiada"), ids: z.array(z.uuid()) });
export const errorDuplicadoSchema = z.object({ codigo: z.literal("duplicado"), id: z.uuid() });

/** GET …/compras/propuestas (DU-19): una descarga de compras del periodo, la más reciente primero. Mismos campos que `PropuestaVentasDto`. */
export const propuestaComprasSchema = z.object({
  id: z.uuid(),
  fuente: z.enum(["api", "importacion"]),
  filasRecibidas: entero,
  filasNuevas: entero,
  filasIguales: entero,
  filasDistintas: entero,
  creadaEn: fechaIso,
});
export type PropuestaComprasDto = z.infer<typeof propuestaComprasSchema>;

/** GET …/compras/propuestas/:propuestaId/diferencias (DU-19): lo que el SIRE trajo distinto de lo guardado. Mismos campos que `DiferenciaVentasDto`. */
export const diferenciaComprasSchema = z.object({
  clave: z.string(),
  tipo: z.string(),
  serie: z.string(),
  numero: z.string(),
  /** `agregada` se informa como `manual` (013, punto 8). */
  origenExistente: z.enum(["sire", "manual"]),
  campos: z.array(z.string()),
  valoresSire: z.record(z.string(), z.string()),
});
export type DiferenciaComprasDto = z.infer<typeof diferenciaComprasSchema>;
