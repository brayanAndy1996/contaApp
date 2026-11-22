// Repositorio de meses ingresados a mano, versionados, y del historial del mes (spec 026, R-5, D-4; CA-3, CA-4). Escribe solo por
// `prorrata_mes_manual_guardar` y `prorrata_mes_manual_eliminar` (0066, backend con usuario); lee con la RLS del estudio.
import type { TxConsulta } from "../compras/errores";
import {
  aDeclaracion,
  COLUMNAS_DECLARACION,
  type DeclaracionFila,
} from "./declaraciones";
import {
  consultarProrrata,
  esUuidProrrata,
  exigirMonto,
  exigirPeriodos,
  exigirVersion,
  type FilaProrrata,
} from "./errores";

export interface ManualFila {
  periodo: string;
  version: number;
  accion: "guardado" | "eliminado";
  /** `null` en las tres si la acción es `eliminado`. */
  gravadas: string | null;
  exportaciones: string | null;
  noGravadas: string | null;
  motivo: string;
  autor: { id: string; nombre: string };
  creadoEn: Date;
}

const COLUMNAS_MANUAL = `m.periodo::text as periodo, m.version, m.accion, m.gravadas::text as gravadas,
  m.exportaciones::text as exportaciones, m.no_gravadas::text as no_gravadas, m.motivo, m.autor, coalesce(u.nombre, '') as nombre,
  m.creado_en`;

// La de MAYOR versión de cada periodo, sea `guardado` o `eliminado` (el CAS necesita su versión).
const SQL_VIGENTES = `select distinct on (m.periodo) ${COLUMNAS_MANUAL}
  from prorrata_mes_manual m left join usuario u on u.id = m.autor
  where m.cliente_id = $1 and m.periodo = any($2::bpchar[])
  order by m.periodo, m.version desc`;

const SQL_VERSIONES = `select ${COLUMNAS_MANUAL}
  from prorrata_mes_manual m left join usuario u on u.id = m.autor
  where m.cliente_id = $1 and m.periodo = $2::bpchar order by m.version`;

const SQL_PRESENTACIONES = `select ${COLUMNAS_DECLARACION} from declaracion_mensual d
  where d.cliente_id = $1 and d.periodo = $2::bpchar order by d.numero_orden`;

const SQL_GUARDAR =
  "select public.prorrata_mes_manual_guardar($1::uuid, $2::bpchar, $3::numeric, $4::numeric, $5::numeric, $6::text, $7::integer) as version";
const SQL_ELIMINAR =
  "select public.prorrata_mes_manual_eliminar($1::uuid, $2::bpchar, $3::text, $4::integer) as version";

const aManual = (f: FilaProrrata): ManualFila => ({
  periodo: f.periodo,
  version: f.version,
  accion: f.accion,
  gravadas: f.gravadas,
  exportaciones: f.exportaciones,
  noGravadas: f.no_gravadas,
  motivo: f.motivo,
  autor: { id: f.autor, nombre: f.nombre },
  creadoEn: f.creado_en,
});

/** Una fila por periodo con historial (la de mayor versión, también `eliminado`), ordenadas por periodo. */
export async function leerManuales(
  tx: TxConsulta,
  clienteId: string,
  periodos: string[],
): Promise<ManualFila[]> {
  const lista = exigirPeriodos(periodos);
  if (!esUuidProrrata(clienteId) || lista.length === 0) return [];
  return (await consultarProrrata(tx, SQL_VIGENTES, [clienteId, lista])).map(aManual);
}

/** Todas las presentaciones del periodo (por número de orden) y todas las versiones del manual (por versión ascendente). */
export async function leerHistorialMes(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
): Promise<{ declaraciones: DeclaracionFila[]; manual: ManualFila[] }> {
  if (!esUuidProrrata(clienteId) || typeof periodo !== "string")
    return { declaraciones: [], manual: [] };
  const declaraciones = await consultarProrrata(tx, SQL_PRESENTACIONES, [clienteId, periodo]);
  const manual = await consultarProrrata(tx, SQL_VERSIONES, [clienteId, periodo]);
  return { declaraciones: declaraciones.map(aDeclaracion), manual: manual.map(aManual) };
}

/** Guarda la versión `version + 1` del mes; `version` = la última del mes (0 si nunca tuvo manual). CA412 mes declarado; CA409. */
export async function guardarMesManual(
  tx: TxConsulta,
  e: {
    clienteId: string;
    periodo: string;
    gravadas: string;
    exportaciones: string;
    noGravadas: string;
    motivo: string;
    version: number;
  },
): Promise<number> {
  const [f] = await consultarProrrata(tx, SQL_GUARDAR, [
    e.clienteId,
    e.periodo,
    exigirMonto(e.gravadas),
    exigirMonto(e.exportaciones),
    exigirMonto(e.noGravadas),
    e.motivo,
    exigirVersion(e.version),
  ]);
  return Number(f?.version);
}

/** Elimina el manual vivo en `version` (nueva versión `eliminado`, sin montos); CA409 sin manual vivo o con otra versión. */
export async function eliminarMesManual(
  tx: TxConsulta,
  e: { clienteId: string; periodo: string; motivo: string; version: number },
): Promise<number> {
  const [f] = await consultarProrrata(tx, SQL_ELIMINAR, [
    e.clienteId,
    e.periodo,
    e.motivo,
    exigirVersion(e.version),
  ]);
  return Number(f?.version);
}
