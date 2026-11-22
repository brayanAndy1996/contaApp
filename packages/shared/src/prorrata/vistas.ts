import { z } from "zod";
import { estadoPeriodoSchema } from "../compras/esquemas.js";
import { montoProrrataSchema, PERIODO_PRORRATA_RE, PORCENTAJE_VISTA_RE } from "./esquemas.js";

// Spec 026 (plan, Contratos: shared; D-4, D-6, D-7; R-2b, R-4, R-5, R-7, R-8). Vistas de la prorrata.
// Montos y porcentajes son CADENAS (montos con signo y hasta 2 decimales; porcentajes «NN.NN»). `z.object` descarta
// cualquier clave no declarada: tenant, cliente, RUC o clave nunca viajan.
const periodo = z.string().regex(PERIODO_PRORRATA_RE);
const monto = montoProrrataSchema;
const porcentaje = z.string().regex(PORCENTAJE_VISTA_RE);
const instante = z.iso.datetime();
const entero0 = z.number().int().min(0);

export const ORIGENES_MES = ["declarado", "manual", "sire", "falta"] as const;
export type OrigenMes = (typeof ORIGENES_MES)[number];

export const AVISOS_MES = ["usd_sin_tipo_cambio", "sire_sin_exportaciones", "manual_reemplazado"] as const;
export type AvisoMes = (typeof AVISOS_MES)[number];

export const AVISOS_COEFICIENTE = ["numerador_cero", "exportaciones_en_sire"] as const;
export type AvisoCoeficiente = (typeof AVISOS_COEFICIENTE)[number];

export const TIPOS_DECLARACION = ["original", "rectificatoria"] as const;
export type TipoDeclaracion = (typeof TIPOS_DECLARACION)[number];

export const MOTIVOS_NO_DETERMINABLE = ["total_cero", "acumulado_invalido"] as const;
export const MOTIVOS_NO_ESTIMABLE = ["coeficiente", "sin_ventas", "sin_compras"] as const;
export const SITUACIONES_IGV = ["a_pagar", "saldo_a_favor", "cero"] as const;

const numeroOrden = z.string().regex(/^[0-9]{1,15}$/);
const autor = z.object({ id: z.uuid(), nombre: z.string().min(1) });

export const mesVistaSchema = z.object({
  periodo,
  origen: z.enum(ORIGENES_MES),
  gravadas: monto,
  exportaciones: monto,
  noGravadas: monto,
  total: monto,
  avisos: z.array(z.enum(AVISOS_MES)),
  declaracion: z
    .object({
      numeroOrden,
      fechaPresentacion: z.iso.date(),
      tipo: z.enum(TIPOS_DECLARACION),
      presentaciones: z.number().int().min(1),
    })
    .nullable(),
  manual: z.object({ motivo: z.string().min(1), autor, guardadoEn: instante }).nullable(),
  versionManual: entero0,
  sireCargado: z.boolean(),
});
export type MesVista = z.infer<typeof mesVistaSchema>;

export const coeficienteVistaSchema = z.discriminatedUnion("estado", [
  z.object({
    estado: z.literal("calculado"),
    porcentaje,
    numerador: monto,
    total: monto,
    provisional: z.boolean(),
    avisos: z.array(z.enum(AVISOS_COEFICIENTE)),
  }),
  z.object({ estado: z.literal("faltan_meses"), faltantes: z.array(periodo).min(1).max(12) }),
  z.object({ estado: z.literal("no_determinable"), motivo: z.enum(MOTIVOS_NO_DETERMINABLE) }),
]);
export type CoeficienteVista = z.infer<typeof coeficienteVistaSchema>;

export const igvEstimadoVistaSchema = z.discriminatedUnion("estado", [
  z.object({
    estado: z.literal("calculado"),
    igvVentas: monto,
    creditoDg: monto,
    igvDgng: monto,
    creditoDgng: monto,
    igvDng: monto,
    resultado: monto,
    situacion: z.enum(SITUACIONES_IGV),
    estadoPeriodoCompras: estadoPeriodoSchema,
  }),
  z.object({ estado: z.literal("no_estimable"), motivo: z.enum(MOTIVOS_NO_ESTIMABLE) }),
]);
export type IgvEstimadoVista = z.infer<typeof igvEstimadoVistaSchema>;

export const prorrataVistaSchema = z.object({
  periodo,
  ventana: z.array(mesVistaSchema).length(12),
  coeficiente: coeficienteVistaSchema,
  igvEstimado: igvEstimadoVistaSchema,
  diferencia: z.object({ diferencia: porcentaje, alerta: z.boolean() }).nullable(),
  ultimaObtencion: z.object({ obtenidaEn: instante, periodosSinDeclaracion: z.array(periodo) }).nullable(),
  prorrataUsada: z.object({ valor: porcentaje, origen: z.enum(["declarada", "ingresada"]) }).nullable(),
  versionUsada: entero0,
});
export type ProrrataVista = z.infer<typeof prorrataVistaSchema>;

export const historialMesVistaSchema = z.object({
  declaraciones: z.array(
    z.object({
      numeroOrden,
      fechaPresentacion: z.iso.date(),
      tipo: z.enum(TIPOS_DECLARACION),
      gravadas: monto,
      exportaciones: monto,
      noGravadas: monto,
      prorrataUsada: porcentaje.nullable(),
      obtenidaEn: instante,
    }),
  ),
  manual: z.array(
    z.object({
      version: z.number().int().min(1),
      accion: z.enum(["guardado", "eliminado"]),
      montos: z.object({ gravadas: monto, exportaciones: monto, noGravadas: monto }).nullable(),
      motivo: z.string().min(1),
      autor,
      en: instante,
    }),
  ),
});
export type HistorialMesVista = z.infer<typeof historialMesVistaSchema>;
