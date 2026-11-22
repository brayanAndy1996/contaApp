// Repositorio de la prorrata usada ingresada por el contador, versionada (spec 026, R-8, U-9; CA-6). Escribe solo por
// `prorrata_usada_guardar` (0066, backend con usuario); lee con la RLS del estudio. La declarada del PDT no se mezcla aquí: el dominio
// decide el origen («declarada» gana a «ingresada»).
import type { TxConsulta } from "../compras/errores";
import {
  consultarProrrata,
  esUuidProrrata,
  exigirPorcentaje,
  exigirVersion,
} from "./errores";

export interface UsadaFila {
  periodo: string;
  version: number;
  /** «NN.NN» o `null` (la ingresada se dejó sin valor). */
  porcentaje: string | null;
  autor: { id: string; nombre: string };
  creadoEn: Date;
}

const SQL_VIGENTE = `select u.periodo::text as periodo, u.version, u.porcentaje::text as porcentaje, u.autor,
    coalesce(us.nombre, '') as nombre, u.creado_en
  from prorrata_usada_manual u left join usuario us on us.id = u.autor
  where u.cliente_id = $1 and u.periodo = $2::bpchar order by u.version desc limit 1`;

const SQL_GUARDAR =
  "select public.prorrata_usada_guardar($1::uuid, $2::bpchar, $3::numeric, $4::integer) as version";

/** La de mayor versión del periodo (aunque su porcentaje sea null), o `null` si nunca se ingresó. */
export async function leerUsada(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
): Promise<UsadaFila | null> {
  if (!esUuidProrrata(clienteId) || typeof periodo !== "string") return null;
  const [f] = await consultarProrrata(tx, SQL_VIGENTE, [clienteId, periodo]);
  if (f === undefined) return null;
  return {
    periodo: f.periodo,
    version: f.version,
    porcentaje: f.porcentaje,
    autor: { id: f.autor, nombre: f.nombre },
    creadoEn: f.creado_en,
  };
}

/** Guarda la versión `version + 1` («NN.NN» o null); CA413 si el PDT vigente ya la trae; CA409 si la versión no es la última. */
export async function guardarUsada(
  tx: TxConsulta,
  e: {
    clienteId: string;
    periodo: string;
    porcentaje: string | null;
    version: number;
  },
): Promise<number> {
  const [f] = await consultarProrrata(tx, SQL_GUARDAR, [
    e.clienteId,
    e.periodo,
    exigirPorcentaje(e.porcentaje),
    exigirVersion(e.version),
  ]);
  return Number(f?.version);
}
