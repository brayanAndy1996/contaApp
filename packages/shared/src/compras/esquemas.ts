import { z } from "zod";

// Spec 014 (plan, Contratos: HTTP). Cuerpos de las acciones de compras. Los montos viajan siempre como
// cadenas decimales de NUMERIC(14,2): ningún esquema acepta un `number` para dinero. `z.object` descarta
// las claves desconocidas, así que un tenantId, usuarioId, clienteId u origen del cuerpo nunca viaja.

/** Signo opcional, hasta 12 enteros sin ceros a la izquierda y hasta 2 decimales: ±999999999999.99. */
const GRAMATICA_MONTO = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;
/** Hasta 4 enteros y 3 decimales (como TipoCambio de 010); que sea mayor que cero se comprueba aparte. */
const GRAMATICA_TIPO_CAMBIO = /^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$/;
const PERIODO = /^[0-9]{4}(0[1-9]|1[0-2])$/;

export const montoDecimalSchema = z.string().max(16).regex(GRAMATICA_MONTO);
export type MontoDecimal = z.infer<typeof montoDecimalSchema>;

/** AAAAMM con mes 01 a 12. El rechazo de un periodo futuro es del servicio. */
export const periodoComprasSchema = z.string().regex(PERIODO);

/** n de la versión sobre la que el usuario actuó (D-2). */
export const versionBaseSchema = z.number().int().min(1);

export const DESTINOS_COMPRA = ["DG", "DGNG", "DNG"] as const;
export type DestinoCompra = (typeof DESTINOS_COMPRA)[number];
export const destinoCompraSchema = z.enum(DESTINOS_COMPRA);

/** Las 10 columnas de montos de 010, en su orden. El total no se edita: es Σ de ellas. */
export const COLUMNAS_MONTO_COMPRA = [
  "biDg",
  "igvDg",
  "biDgng",
  "igvDgng",
  "biDng",
  "igvDng",
  "noGravado",
  "isc",
  "icbper",
  "otrosTributos",
] as const;
export type ColumnaMontoCompra = (typeof COLUMNAS_MONTO_COMPRA)[number];
export const columnaMontoCompraSchema = z.enum(COLUMNAS_MONTO_COMPRA);

/** Subconjunto de las 10 columnas; una clave que no es columna (total incluido) se descarta. */
export const montosColumnasSchema = z.object({
  biDg: montoDecimalSchema.optional(),
  igvDg: montoDecimalSchema.optional(),
  biDgng: montoDecimalSchema.optional(),
  igvDgng: montoDecimalSchema.optional(),
  biDng: montoDecimalSchema.optional(),
  igvDng: montoDecimalSchema.optional(),
  noGravado: montoDecimalSchema.optional(),
  isc: montoDecimalSchema.optional(),
  icbper: montoDecimalSchema.optional(),
  otrosTributos: montoDecimalSchema.optional(),
});
export type MontosColumnas = z.infer<typeof montosColumnasSchema>;

export const CODIGOS_REGLA = ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP"] as const;
export type CodigoReglaCompra = (typeof CODIGOS_REGLA)[number];
export const reglaCompraSchema = z.enum(CODIGOS_REGLA);

/**
 * H-014-3: texto de una línea sin caracteres de control (categoría Unicode Cc: C0, DEL y C1). PostgreSQL rechaza el NUL en `text`
 * y daba 500. A diferencia de los comentarios de 013 (un `textarea`), aquí tampoco valen \t, \n ni \r: la razón social, el motivo
 * de exclusión y la búsqueda son campos de una línea y un salto de línea rompería la fila del Excel y del TXT.
 */
export const sinControles = (s: string): boolean => !/\p{Cc}/u.test(s);

export const MOTIVO_EXCLUSION_MAX = 200;
const motivoSchema = z.string().max(MOTIVO_EXCLUSION_MAX).refine(sinControles);

export const clasificarCompraSchema = z.object({ versionBase: versionBaseSchema, destino: destinoCompraSchema });
export type ClasificarCompra = z.infer<typeof clasificarCompraSchema>;

/**
 * DU-18: editar exige al menos una columna. Las claves que no son columna (total incluido) se descartan al analizar, así que
 * `{ total }` o `{ desconocida }` quedan vacíos y también se rechazan. `calcular` sigue aceptando `{}`: no escribe nada.
 */
const cambiosEdicionSchema = montosColumnasSchema.refine((c) => Object.values(c).some((v) => v !== undefined), {
  message: "cambios debe traer al menos una columna",
});
export const editarCompraSchema = z.object({ versionBase: versionBaseSchema, cambios: cambiosEdicionSchema });
export type EditarCompra = z.infer<typeof editarCompraSchema>;

/** Vista previa (D-16): no lleva versionBase y no escribe nada. */
export const calcularCompraSchema = z.object({ cambios: montosColumnasSchema });
export type CalcularCompra = z.infer<typeof calcularCompraSchema>;

/** Lo que pide el 422 `requiere_dato`: el monto gravado (R-MIX) o el destino (R-NEW). */
export const datoSugerenciaSchema = z.union([
  z.object({ gravado: montoDecimalSchema }),
  z.object({ destino: destinoCompraSchema }),
]);
export type DatoSugerencia = z.infer<typeof datoSugerenciaSchema>;

export const aceptarSugerenciaSchema = z.object({
  versionBase: versionBaseSchema,
  regla: reglaCompraSchema,
  confirmar: z.boolean().optional(),
  dato: datoSugerenciaSchema.optional(),
});
export type AceptarSugerencia = z.infer<typeof aceptarSugerenciaSchema>;

export const excluirCompraSchema = z.object({ versionBase: versionBaseSchema, motivo: motivoSchema.optional() });
export type ExcluirCompra = z.infer<typeof excluirCompraSchema>;

export const restaurarCompraSchema = z.object({ versionBase: versionBaseSchema });
export type RestaurarCompra = z.infer<typeof restaurarCompraSchema>;

/** Solo vale para una compra agregada (409 `no_descartable` si no). */
export const descartarCompraSchema = z.object({ versionBase: versionBaseSchema });
export type DescartarCompra = z.infer<typeof descartarCompraSchema>;

export const MONEDAS_COMPRA = ["PEN", "USD"] as const;
export type MonedaCompra = (typeof MONEDAS_COMPRA)[number];

/** Tipo de cambio como texto (hasta 4 enteros y 3 decimales). Que sea mayor que cero lo comprueba `agregarCompraSchema`. */
export const tipoCambioSchema = z.string().regex(GRAMATICA_TIPO_CAMBIO);

/** Identidad de un comprobante (tipo, serie, número): gramática de la compra agregada a mano. */
export const identidadCompraSchema = z.object({
  tipo: z.string().regex(/^[0-9]{2}$/),
  serie: z.string().regex(/^[0-9A-Z]{1,4}$/),
  numero: z.string().regex(/^[0-9]{1,8}$/),
});

/** Proveedor de una compra agregada. La razón social es texto no confiable de una línea. */
export const proveedorCompraSchema = z.object({
  tipo: z.string().regex(/^[0-9A-Z]$/),
  numero: z.string().regex(/^[0-9A-Za-z]{1,15}$/),
  razonSocial: z.string().min(1).max(100).refine(sinControles),
});

/**
 * Agregar una compra a mano (D-7). La razón social es texto no confiable: se guarda tal cual y quien la
 * muestra la escapa. El total no se envía (es Σ de `montos`). USD exige tipo de cambio y PEN lo prohíbe.
 */
export const agregarCompraSchema = identidadCompraSchema
  .extend({
    proveedor: proveedorCompraSchema,
    fecha: z.iso.date(),
    moneda: z.enum(MONEDAS_COMPRA),
    tipoCambio: tipoCambioSchema.optional(),
    montos: montosColumnasSchema,
  })
  .superRefine((v, ctx) => {
    if (v.moneda === "PEN") {
      if (v.tipoCambio !== undefined) ctx.addIssue({ code: "custom", path: ["tipoCambio"], message: "tipoCambio no va en PEN" });
      return;
    }
    if (v.tipoCambio === undefined) {
      ctx.addIssue({ code: "custom", path: ["tipoCambio"], message: "tipoCambio es obligatorio en USD" });
    } else if (!/[1-9]/.test(v.tipoCambio)) {
      ctx.addIssue({ code: "custom", path: ["tipoCambio"], message: "tipoCambio debe ser mayor que cero" });
    }
  });
export type AgregarCompra = z.infer<typeof agregarCompraSchema>;

export const ESTADOS_PERIODO_COMPRAS = ["abierto", "revisado", "generado"] as const;
export type EstadoPeriodoCompras = (typeof ESTADOS_PERIODO_COMPRAS)[number];
export const estadoPeriodoSchema = z.enum(ESTADOS_PERIODO_COMPRAS);

/** Respuesta de marcar revisado y de reabrir; `por` y `en` son null mientras nadie haya marcado el periodo. */
export const estadoPeriodoRespuestaSchema = z.object({
  estado: estadoPeriodoSchema,
  por: z.uuid().nullable(),
  en: z.iso.datetime().nullable(),
});
export type EstadoPeriodoRespuesta = z.infer<typeof estadoPeriodoRespuestaSchema>;

/**
 * DU-23: cuerpo de `POST …/estado/reabrir`. `estadoVisto` es el estado que vio quien lo pide; el servicio reabre solo si el
 * periodo sigue en ESE estado (compare-and-set). No admite `abierto`: no hay nada que reabrir.
 */
export const reabrirPeriodoSchema = z.object({ estadoVisto: z.enum(["revisado", "generado"]) });
export type ReabrirPeriodo = z.infer<typeof reabrirPeriodoSchema>;
