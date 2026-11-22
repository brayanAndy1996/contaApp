// Repositorio de declaraciones del PDT 621 y de obtenciones (spec 026, D-3, D-4; R-5; CA-1, CA-3, CA-7). SQL estático y parametrizado
// en la `tx` de withTenant: el worker escribe solo por `prorrata_declaraciones_registrar` (0066); el backend lee con la RLS del estudio.
// Montos como cadenas (NUMERIC -> text), nunca `number`.
import type { TxConsulta } from "../compras/errores";
import {
  ARGUMENTO_INVALIDO,
  consultarProrrata,
  esUuidProrrata,
  exigirPeriodos,
  ProrrataRepoError,
  type FilaProrrata,
} from "./errores";

/** Una presentación del PDT 621: montos como cadenas decimales («1000.50»), `numeroOrden` como cadena de 1 a 15 dígitos. */
export interface DeclaracionNueva {
  periodo: string;
  numeroOrden: string;
  fechaPresentacion: string;
  tipo: "original" | "rectificatoria";
  ventasGravadasBase: string;
  ventasGravadasIgv: string;
  exportaciones: string;
  noGravadas: string;
  igvAdquisicionesDg: string;
  igvAdquisicionesDgng: string;
  prorrataUsada: string | null;
}

export interface DeclaracionFila extends DeclaracionNueva {
  obtencionId: string;
}

export interface ObtencionFila {
  id: string;
  periodoHasta: string;
  periodosLeidos: string[];
  periodosSinDeclaracion: string[];
  nuevas: number;
  trabajoId: string | null;
  obtenidaEn: Date;
}

/** Columnas de `declaracion_mensual` en la forma de `DeclaracionFila` (el alias `d`). */
export const COLUMNAS_DECLARACION = `d.periodo::text as periodo, d.numero_orden::text as numero_orden,
  to_char(d.fecha_presentacion, 'YYYY-MM-DD') as fecha_presentacion, d.tipo, d.ventas_gravadas_base::text as ventas_gravadas_base,
  d.ventas_gravadas_igv::text as ventas_gravadas_igv, d.exportaciones::text as exportaciones, d.no_gravadas::text as no_gravadas,
  d.igv_adq_dg::text as igv_adq_dg, d.igv_adq_dgng::text as igv_adq_dgng, d.prorrata_usada::text as prorrata_usada,
  d.obtencion_id`;

// Todas las presentaciones (original y rectificatorias) por periodo y número de orden NUMÉRICO; la vigente la elige el dominio.
const SQL_DECLARACIONES = `select ${COLUMNAS_DECLARACION} from declaracion_mensual d
  where d.cliente_id = $1 and d.periodo = any($2::bpchar[]) order by d.periodo, d.numero_orden`;

const SQL_ULTIMA_OBTENCION = `select o.id, o.periodo_hasta::text as periodo_hasta, o.periodos_leidos::text[] as periodos_leidos,
    o.periodos_sin_declaracion::text[] as periodos_sin_declaracion, o.nuevas, o.trabajo_id, o.obtenida_en
  from prorrata_obtencion o where o.cliente_id = $1 and o.periodo_hasta = $2::bpchar
  order by o.obtenida_en desc, o.id desc limit 1`;

const SQL_REGISTRAR =
  "select public.prorrata_declaraciones_registrar($1::uuid, $2::uuid, $3::bpchar, $4::bpchar[], $5::bpchar[], $6::jsonb) as n";

export const aDeclaracion = (f: FilaProrrata): DeclaracionFila => ({
  periodo: f.periodo,
  numeroOrden: f.numero_orden,
  fechaPresentacion: f.fecha_presentacion,
  tipo: f.tipo,
  ventasGravadasBase: f.ventas_gravadas_base,
  ventasGravadasIgv: f.ventas_gravadas_igv,
  exportaciones: f.exportaciones,
  noGravadas: f.no_gravadas,
  igvAdquisicionesDg: f.igv_adq_dg,
  igvAdquisicionesDgng: f.igv_adq_dgng,
  prorrataUsada: f.prorrata_usada,
  obtencionId: f.obtencion_id,
});

/** Todas las presentaciones de esos periodos del cliente, por periodo y número de orden numérico (vacío si no hay o no se ven). */
export async function leerDeclaraciones(
  tx: TxConsulta,
  clienteId: string,
  periodos: string[],
): Promise<DeclaracionFila[]> {
  const lista = exigirPeriodos(periodos);
  if (!esUuidProrrata(clienteId) || lista.length === 0) return [];
  const filas = await consultarProrrata(tx, SQL_DECLARACIONES, [clienteId, lista]);
  return filas.map(aDeclaracion);
}

/** La obtención más reciente del cliente con ese `periodoHasta`, o `null`. */
export async function leerUltimaObtencion(
  tx: TxConsulta,
  clienteId: string,
  periodoHasta: string,
): Promise<ObtencionFila | null> {
  if (!esUuidProrrata(clienteId) || typeof periodoHasta !== "string") return null;
  const [f] = await consultarProrrata(tx, SQL_ULTIMA_OBTENCION, [clienteId, periodoHasta]);
  if (f === undefined) return null;
  return {
    id: f.id,
    periodoHasta: f.periodo_hasta,
    periodosLeidos: f.periodos_leidos,
    periodosSinDeclaracion: f.periodos_sin_declaracion,
    nuevas: f.nuevas,
    trabajoId: f.trabajo_id,
    obtenidaEn: f.obtenida_en,
  };
}

/**
 * Registra una obtención del worker (una transacción, sin SAVEPOINT) y devuelve cuántas presentaciones eran nuevas: repetir la misma
 * obtención devuelve 0 y no sobrescribe. Todo defecto de entrada es 22023 sin escribir nada; P0002 cliente ajeno; 55000 archivado.
 */
export async function registrarDeclaraciones(
  tx: TxConsulta,
  e: {
    clienteId: string;
    trabajoId: string;
    periodoHasta: string;
    leidos: string[];
    sinDeclaracion: string[];
    declaraciones: DeclaracionNueva[];
  },
): Promise<number> {
  if (!Array.isArray(e.declaraciones)) throw new ProrrataRepoError(ARGUMENTO_INVALIDO);
  // Exactamente las claves que valida la función (snake_case); los valores van tal cual (cadenas o null).
  const declaraciones = e.declaraciones.map((d) => ({
    periodo: d.periodo,
    numero_orden: d.numeroOrden,
    fecha_presentacion: d.fechaPresentacion,
    tipo: d.tipo,
    ventas_gravadas_base: d.ventasGravadasBase,
    ventas_gravadas_igv: d.ventasGravadasIgv,
    exportaciones: d.exportaciones,
    no_gravadas: d.noGravadas,
    igv_adq_dg: d.igvAdquisicionesDg,
    igv_adq_dgng: d.igvAdquisicionesDgng,
    prorrata_usada: d.prorrataUsada,
  }));
  const [f] = await consultarProrrata(tx, SQL_REGISTRAR, [
    e.clienteId,
    e.trabajoId,
    e.periodoHasta,
    exigirPeriodos(e.leidos),
    exigirPeriodos(e.sinDeclaracion),
    JSON.stringify(declaraciones),
  ]);
  return Number(f?.n);
}
