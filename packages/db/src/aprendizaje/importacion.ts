// Repositorio de importaciones del aprendizaje del historial (spec 025, D-2, D-4; CA-3 a CA-5). Solo SQL estático y parametrizado en
// la `tx` de withTenant: escribe únicamente por las funciones acotadas de 0062 (iniciar y fijar el trabajo: backend; completar y
// fallar: worker) y lee con la RLS del estudio. De todo error de `pg` solo se conserva el SQLSTATE (los mensajes, el detalle o la
// tabla pueden traer RUC o razón social): AprendizajeRepoError.
import type { TxConsulta } from "../compras/errores";
import type { DestinoRegla } from "../reglas/tipos";

const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` si el valor es un uuid en texto (los ids que no lo son no llegan a la BD: no existen). */
export const esUuidAprendizaje = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

/** SQLSTATE de la BD (`P0002`, `55000`, `23505`, `22023`, `42501`, `CA409`, ...) o `"desconocido"`; nunca el mensaje ni el detalle. */
export class AprendizajeRepoError extends Error {
  readonly codigo: string;
  constructor(codigo: string) {
    super(`Error de base de datos en aprendizaje (SQLSTATE ${codigo})`);
    this.name = "AprendizajeRepoError";
    this.codigo = codigo;
  }
  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): AprendizajeRepoError {
    // Object(): un valor que no es objeto (null, una cadena) no trae `code`.
    const code: unknown = (Object(error) as { code?: unknown }).code;
    return new AprendizajeRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FilaAprendizaje = Record<string, any>;

/** Consulta parametrizada (texto estático) en la tx; todo error de `pg` sale como AprendizajeRepoError. */
export async function consultarAprendizaje(
  tx: TxConsulta,
  texto: string,
  valores: unknown[] = [],
): Promise<FilaAprendizaje[]> {
  try {
    const r = await tx.query(texto, valores);
    return r.rows as FilaAprendizaje[];
  } catch (e) {
    throw AprendizajeRepoError.desde(e);
  }
}

/** Como `consultarAprendizaje`, pero un id que no es uuid no llega a la BD (no existe: sin filas). */
export async function consultarPorId(
  tx: TxConsulta,
  id: string,
  texto: string,
  valores: unknown[],
): Promise<FilaAprendizaje[]> {
  return esUuidAprendizaje(id) ? consultarAprendizaje(tx, texto, valores) : [];
}

export type EstadoImportacion = "en_curso" | "completada" | "fallida";

export interface ResumenImportacion {
  periodosLeidos: number;
  periodosSinDatos: string[];
  candidatas: number;
  sinCriterio: number;
}

export interface ImportacionFila {
  id: string;
  estado: EstadoImportacion;
  periodos: string[];
  solicitadaPor: { id: string; nombre: string };
  solicitadaEn: Date;
  terminadaEn: Date | null;
  resumen: ResumenImportacion | null;
  motivo: string | null;
  trabajoId: string | null;
}

/** Lo que el worker necesita para trabajar una importación. */
export interface ImportacionParaTrabajo {
  id: string;
  clienteId: string;
  estado: EstadoImportacion;
  periodos: string[];
  ruc: string;
}

export interface CandidataNueva {
  proveedor: { tipo: string; numero: string };
  razonSocial: string | null;
  destino: DestinoRegla | null;
  conteos: {
    DG: number;
    DGNG: number;
    DNG: number;
    mixto: number;
    total: number;
  };
  periodosConProveedor: number;
}

const SQL_INICIAR =
  "select public.reglas_importacion_iniciar($1::uuid, $2::char(6)[]) as id";
const SQL_TRABAJO =
  "select public.reglas_importacion_trabajo($1::uuid, $2::uuid)";
const SQL_COMPLETAR =
  "select public.reglas_importacion_completar($1::uuid, $2::jsonb, $3::jsonb) as n";
const SQL_FALLAR =
  "select public.reglas_importacion_fallar($1::uuid, $2::text)";

// La más reciente del cliente, sea cual sea su estado (la RLS deja ver solo el estudio). El nombre del solicitante, si sigue visible.
const SQL_ULTIMA = `select i.id, i.estado, i.periodos::text[] as periodos, i.solicitada_por, coalesce(u.nombre, '') as nombre,
    i.solicitada_en, i.terminada_en, coalesce(i.periodos_leidos, 0) as periodos_leidos,
    coalesce(i.periodos_sin_datos, '{}')::text[] as periodos_sin_datos, coalesce(i.candidatas, 0) as candidatas,
    coalesce(i.sin_criterio, 0) as sin_criterio, i.motivo, i.trabajo_id
  from regla_importacion i
  left join usuario u on u.id = i.solicitada_por
  where i.cliente_id = $1
  order by i.solicitada_en desc, i.id desc
  limit 1`;

const SQL_LEER = `select i.id, i.cliente_id, i.estado, i.periodos::text[] as periodos, c.ruc
  from regla_importacion i
  join cliente c on c.tenant_id = i.tenant_id and c.id = i.cliente_id
  where i.id = $1`;

/** Crea la importación en curso del cliente (`reglas_importacion_iniciar`) y devuelve su id. */
export async function iniciarImportacion(
  tx: TxConsulta,
  e: { clienteId: string; periodos: string[] },
): Promise<string> {
  const filas = await consultarAprendizaje(tx, SQL_INICIAR, [
    e.clienteId,
    e.periodos,
  ]);
  return filas[0]!.id as string;
}

/** Fija el trabajo encolado de la importación (`reglas_importacion_trabajo`). */
export async function fijarTrabajoImportacion(
  tx: TxConsulta,
  e: { importacionId: string; trabajoId: string },
): Promise<void> {
  await consultarAprendizaje(tx, SQL_TRABAJO, [e.importacionId, e.trabajoId]);
}

/** La importación más reciente del cliente, o `null` (sin importaciones, cliente ajeno o inexistente). */
export async function ultimaImportacion(
  tx: TxConsulta,
  clienteId: string,
): Promise<ImportacionFila | null> {
  const f = (await consultarPorId(tx, clienteId, SQL_ULTIMA, [clienteId]))[0];
  if (!f) return null;
  const estado = f.estado as EstadoImportacion;
  return {
    id: f.id as string,
    estado,
    periodos: f.periodos as string[],
    solicitadaPor: {
      id: f.solicitada_por as string,
      nombre: f.nombre as string,
    },
    solicitadaEn: f.solicitada_en as Date,
    terminadaEn: f.terminada_en as Date | null,
    resumen:
      estado === "completada"
        ? {
            periodosLeidos: f.periodos_leidos as number,
            periodosSinDatos: f.periodos_sin_datos as string[],
            candidatas: f.candidatas as number,
            sinCriterio: f.sin_criterio as number,
          }
        : null,
    motivo: f.motivo as string | null,
    trabajoId: f.trabajo_id as string | null,
  };
}

/** Para el worker: la importación con el RUC de su cliente, o `null` si no existe en el estudio. */
export async function leerImportacion(
  tx: TxConsulta,
  importacionId: string,
): Promise<ImportacionParaTrabajo | null> {
  const f = (
    await consultarPorId(tx, importacionId, SQL_LEER, [importacionId])
  )[0];
  if (!f) return null;
  return {
    id: f.id as string,
    clienteId: f.cliente_id as string,
    estado: f.estado as EstadoImportacion,
    periodos: f.periodos as string[],
    ruc: f.ruc as string,
  };
}

/** Deja la importación completada con sus candidatas (`reglas_importacion_completar`, worker). Devuelve cuántas insertó. */
export async function completarImportacion(
  tx: TxConsulta,
  e: {
    importacionId: string;
    resumen: ResumenImportacion;
    candidatas: CandidataNueva[];
  },
): Promise<number> {
  const resumen = {
    periodos_leidos: e.resumen.periodosLeidos,
    periodos_sin_datos: e.resumen.periodosSinDatos,
    candidatas: e.resumen.candidatas,
    sin_criterio: e.resumen.sinCriterio,
  };
  const candidatas = e.candidatas.map((c) => ({
    doc_tipo: c.proveedor.tipo,
    doc_numero: c.proveedor.numero,
    razon_social: c.razonSocial,
    destino_propuesto: c.destino,
    n_dg: c.conteos.DG,
    n_dgng: c.conteos.DGNG,
    n_dng: c.conteos.DNG,
    n_mixto: c.conteos.mixto,
    n_total: c.conteos.total,
    periodos_con_proveedor: c.periodosConProveedor,
  }));
  const filas = await consultarAprendizaje(tx, SQL_COMPLETAR, [
    e.importacionId,
    JSON.stringify(resumen),
    JSON.stringify(candidatas),
  ]);
  return filas[0]!.n as number;
}

/** Cierra la importación en curso como fallida con el motivo de trabajo (`reglas_importacion_fallar`, worker). */
export async function fallarImportacion(
  tx: TxConsulta,
  e: { importacionId: string; motivo: string },
): Promise<void> {
  await consultarAprendizaje(tx, SQL_FALLAR, [e.importacionId, e.motivo]);
}
