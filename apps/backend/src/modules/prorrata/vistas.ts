// Armado de las vistas de la prorrata (spec 026, R-1 a R-8): de las filas de la BD al dominio (`resolverMes`, `calcularProrrata`,
// `estimarIgv`, `compararProrrata`) y de ahí a `ProrrataVista`. Puro y sin IO: lo que viene de la BD ya está leído. Montos y
// porcentajes son cadenas; ningún `number` toca un monto.
import type { DeclaracionFila, ManualFila, ObtencionFila, TotalesVentasPeriodo, UsadaFila } from "@contapp/db";
import {
  calcularProrrata,
  compararProrrata,
  estimarIgv,
  Money,
  resolverMes,
  resumirVentas,
  type FilaResumenVenta,
  type MesFuente,
  type MesProrrata,
  type Presentacion,
  type ResultadoProrrata,
} from "@contapp/domain";
import {
  historialMesVistaSchema,
  prorrataVistaSchema,
  type CoeficienteVista,
  type EstadoPeriodoCompras,
  type HistorialMesVista,
  type IgvEstimadoVista,
  type MesVista,
  type ProrrataVista,
} from "@contapp/shared";
import { aInstante } from "./apoyo.js";

/** Casilleros de las compras de M que usa el IGV estimado (los vigentes del resumen de 014). */
export interface ComprasDeM {
  igvDg: string;
  igvDgng: string;
  igvDng: string;
  estado: EstadoPeriodoCompras;
}

/** Todo lo que la lectura trae de la BD para armar la vista de M. */
export interface DatosProrrata {
  periodo: string;
  ventana: readonly string[];
  declaraciones: readonly DeclaracionFila[];
  manuales: readonly ManualFila[];
  totales: readonly TotalesVentasPeriodo[];
  obtencion: ObtencionFila | null;
  usada: UsadaFila | null;
  comprasCargadas: boolean;
}

/** Un autor sin nombre en la BD (usuario sin nombre o fuera de la vista) sale con una marca legible, nunca con un hueco. */
const NOMBRE_DESCONOCIDO = "Usuario desconocido";
const nombreDe = (n: string): string => (n.length > 0 ? n : NOMBRE_DESCONOCIDO);

const aPresentacion = (d: DeclaracionFila): Presentacion => ({
  numeroOrden: d.numeroOrden,
  fechaPresentacion: d.fechaPresentacion,
  tipo: d.tipo,
  ventasGravadasBase: d.ventasGravadasBase,
  ventasGravadasIgv: d.ventasGravadasIgv,
  exportaciones: d.exportaciones,
  noGravadas: d.noGravadas,
  igvAdquisicionesDg: d.igvAdquisicionesDg,
  igvAdquisicionesDgng: d.igvAdquisicionesDgng,
  prorrataUsada: d.prorrataUsada,
});

function agrupar<T extends { periodo: string }>(filas: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const f of filas) {
    const l = m.get(f.periodo);
    if (l === undefined) m.set(f.periodo, [f]);
    else l.push(f);
  }
  return m;
}

/** Los 12 meses con su fuente: declaraciones (por orden numérico), manual vigente no eliminado y totales SIRE del periodo. */
function armarMeses(d: DatosProrrata): {
  meses: MesProrrata[];
  vista: MesVista[];
} {
  const declaradas = agrupar(d.declaraciones);
  const manuales = new Map(d.manuales.map((m) => [m.periodo, m]));
  const totales = new Map(d.totales.map((t) => [t.periodo, t]));
  const meses: MesProrrata[] = [];
  const vista: MesVista[] = [];
  for (const periodo of d.ventana) {
    const decls = declaradas.get(periodo) ?? [];
    const manual = manuales.get(periodo);
    const vivo = manual !== undefined && manual.accion === "guardado" ? manual : null;
    const sire = totales.get(periodo);
    const fuente: MesFuente = {
      periodo,
      declaraciones: decls.map(aPresentacion),
      manual:
        vivo === null
          ? null
          : {
              gravadas: vivo.gravadas as string,
              exportaciones: vivo.exportaciones as string,
              noGravadas: vivo.noGravadas as string,
            },
      sire:
        sire === undefined || !sire.cargado
          ? null
          : {
              pen: { baseGravada: sire.pen.baseGravada, exonerada: sire.pen.exonerada, inafecta: sire.pen.inafecta },
              usd: sire.usd.map((f) => ({
                baseGravada: f.baseGravada,
                exonerada: f.exonerada,
                inafecta: f.inafecta,
                tipoCambio: f.tipoCambio,
              })),
            },
    };
    const m = resolverMes(fuente);
    meses.push(m);
    // La vigente es la de mayor número de orden; el repositorio ya las entrega ordenadas por ese número.
    const vigente = decls.length === 0 ? null : (decls[decls.length - 1] as DeclaracionFila);
    vista.push({
      periodo,
      origen: m.origen,
      gravadas: m.gravadas.toString(),
      exportaciones: m.exportaciones.toString(),
      noGravadas: m.noGravadas.toString(),
      total: m.total.toString(),
      avisos: [...m.avisos],
      declaracion:
        vigente === null
          ? null
          : {
              numeroOrden: vigente.numeroOrden,
              fechaPresentacion: vigente.fechaPresentacion,
              tipo: vigente.tipo,
              presentaciones: decls.length,
            },
      manual:
        vivo === null
          ? null
          : { motivo: vivo.motivo, autor: { id: vivo.autor.id, nombre: nombreDe(vivo.autor.nombre) }, guardadoEn: aInstante(vivo.creadoEn) },
      versionManual: manual?.version ?? 0,
      sireCargado: sire?.cargado === true,
    });
  }
  return { meses, vista };
}

function aCoeficienteVista(r: ResultadoProrrata): CoeficienteVista {
  switch (r.estado) {
    case "calculado":
      return {
        estado: "calculado",
        porcentaje: r.porcentaje.toString(),
        numerador: r.numerador.toString(),
        total: r.total.toString(),
        provisional: r.provisional,
        avisos: [...r.avisos],
      };
    case "faltan_meses":
      return { estado: "faltan_meses", faltantes: [...r.faltantes] };
    case "no_determinable":
      return { estado: "no_determinable", motivo: r.motivo };
  }
}

/**
 * IGV de ventas de M con las mismas filas y la misma conversión que el resumen de 013: las sumas PEN (hechas en SQL) entran como una
 * fila PEN y cada USD con su tipo de cambio como una fila USD; `resumirVentas` convierte columna por columna y las USD sin tipo de
 * cambio no suman, y lo avisa (H-026-2-6: el aviso pasa al IGV estimado como `ventas_usd_sin_tipo_cambio`).
 */
function igvDeVentas(t: TotalesVentasPeriodo): { igv: Money; sinTipoCambio: boolean } {
  const cero = "0.00";
  const base = { tipo: "00", isc: cero, icbper: cero, otros: cero, total: cero };
  const filas: FilaResumenVenta[] = [
    {
      ...base,
      clave: "pen",
      moneda: "PEN",
      baseGravada: t.pen.baseGravada,
      igv: t.pen.igv,
      exonerada: t.pen.exonerada,
      inafecta: t.pen.inafecta,
    },
    ...t.usd.map(
      (f, i): FilaResumenVenta => ({
        ...base,
        clave: `usd-${i}`,
        moneda: "USD",
        tipoCambio: f.tipoCambio,
        baseGravada: f.baseGravada,
        igv: f.igv,
        exonerada: f.exonerada,
        inafecta: f.inafecta,
      }),
    ),
  ];
  const r = resumirVentas(filas);
  return { igv: Money.desde(r.total.igv, "PEN"), sinTipoCambio: r.avisos.includes("usd_sin_tipo_cambio") };
}

/** IGV estimado de M (R-7). Con el coeficiente tiene precedencia; luego faltan las ventas, luego las compras de M. */
function aIgvVista(
  coeficiente: ResultadoProrrata,
  ventasM: TotalesVentasPeriodo | undefined,
  comprasCargadas: boolean,
  comprasM: ComprasDeM | null,
): IgvEstimadoVista {
  if (coeficiente.estado !== "calculado") return { estado: "no_estimable", motivo: "coeficiente" };
  if (ventasM === undefined || !ventasM.cargado) return { estado: "no_estimable", motivo: "sin_ventas" };
  if (!comprasCargadas || comprasM === null) return { estado: "no_estimable", motivo: "sin_compras" };
  const ventas = igvDeVentas(ventasM);
  const igv = estimarIgv({
    igvVentas: ventas.igv,
    igvDg: Money.desde(comprasM.igvDg, "PEN"),
    igvDgng: Money.desde(comprasM.igvDgng, "PEN"),
    igvDng: Money.desde(comprasM.igvDng, "PEN"),
    prorrata: coeficiente.porcentaje,
  });
  return {
    estado: "calculado",
    igvVentas: igv.igvVentas.toString(),
    creditoDg: igv.creditoDg.toString(),
    igvDgng: igv.igvDgng.toString(),
    creditoDgng: igv.creditoDgng.toString(),
    igvDng: igv.igvDng.toString(),
    resultado: igv.resultado.toString(),
    situacion: igv.situacion,
    estadoPeriodoCompras: comprasM.estado,
    // Sin aviso la clave se omite (el contrato la lee como lista vacía).
    ...(ventas.sinTipoCambio ? { avisos: ["ventas_usd_sin_tipo_cambio" as const] } : {}),
  };
}

/**
 * La prorrata usada de M (R-8, U-9): la del PDT VIGENTE de M si la trae («declarada»); si no, la última ingresada con valor
 * («ingresada»); si no, ninguna. Una ingresada sin valor (se quitó) no cuenta, pero su versión sigue contando para el compare-and-set.
 */
function prorrataUsadaDe(
  declaracionesM: readonly DeclaracionFila[],
  usada: UsadaFila | null,
): { valor: string; origen: "declarada" | "ingresada" } | null {
  const vigente = declaracionesM.length === 0 ? null : (declaracionesM[declaracionesM.length - 1] as DeclaracionFila);
  if (vigente !== null && vigente.prorrataUsada !== null) return { valor: vigente.prorrataUsada, origen: "declarada" };
  if (usada !== null && usada.porcentaje !== null) return { valor: usada.porcentaje, origen: "ingresada" };
  return null;
}

/**
 * `ProrrataVista` de M. `leerCompras` (el resumen de 014) solo se llama si el IGV se puede estimar: coeficiente calculado y M con
 * ventas y compras cargadas; en cualquier otro caso leer 5.000 compras sería en vano.
 */
export async function armarVista(d: DatosProrrata, leerCompras: () => Promise<ComprasDeM>): Promise<ProrrataVista> {
  const { meses, vista } = armarMeses(d);
  const coeficiente = calcularProrrata(meses);
  const ventasM = d.totales.find((t) => t.periodo === d.periodo);
  const comprasM =
    coeficiente.estado === "calculado" && ventasM?.cargado === true && d.comprasCargadas ? await leerCompras() : null;
  const usada = prorrataUsadaDe(
    d.declaraciones.filter((x) => x.periodo === d.periodo),
    d.usada,
  );
  // La vista lleva la diferencia en valor absoluto («NN.NN», como el contrato de `shared`): el dominio la da con signo (calculada − usada)
  // y la alerta (|calculada − usada| ≥ 0.01) sale de él tal cual.
  const comparada =
    coeficiente.estado === "calculado" && usada !== null ? compararProrrata(coeficiente.porcentaje, usada.valor) : null;
  const diferencia =
    comparada === null
      ? null
      : { diferencia: comparada.diferencia.replace(/^-/, ""), alerta: comparada.alerta };
  return prorrataVistaSchema.parse({
    periodo: d.periodo,
    ventana: vista,
    coeficiente: aCoeficienteVista(coeficiente),
    igvEstimado: aIgvVista(coeficiente, ventasM, d.comprasCargadas, comprasM),
    diferencia,
    ultimaObtencion:
      d.obtencion === null
        ? null
        : { obtenidaEn: aInstante(d.obtencion.obtenidaEn), periodosSinDeclaracion: d.obtencion.periodosSinDeclaracion },
    prorrataUsada: usada,
    versionUsada: d.usada?.version ?? 0,
  });
}

/** Historial del mes: todas las presentaciones (con la fecha de su obtención) y todas las versiones del manual. */
export function armarHistorial(
  declaraciones: readonly DeclaracionFila[],
  manual: readonly ManualFila[],
  obtenidaEn: ReadonlyMap<string, Date>,
): HistorialMesVista {
  return historialMesVistaSchema.parse({
    declaraciones: declaraciones.map((d) => ({
      numeroOrden: d.numeroOrden,
      fechaPresentacion: d.fechaPresentacion,
      tipo: d.tipo,
      gravadas: d.ventasGravadasBase,
      exportaciones: d.exportaciones,
      noGravadas: d.noGravadas,
      prorrataUsada: d.prorrataUsada,
      obtenidaEn: aInstante(obtenidaEn.get(d.obtencionId) as Date),
    })),
    manual: manual.map((m) => ({
      version: m.version,
      accion: m.accion,
      montos:
        m.accion === "eliminado"
          ? null
          : { gravadas: m.gravadas, exportaciones: m.exportaciones, noGravadas: m.noGravadas },
      motivo: m.motivo,
      autor: { id: m.autor.id, nombre: nombreDe(m.autor.nombre) },
      en: aInstante(m.creadoEn),
    })),
  });
}
