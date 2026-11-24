// Diccionario del estudio, umbral y globales desactivadas (spec 027, R-6, R-11, R-12). Escribe solo por las funciones acotadas de 0070
// (backend con usuario); lee con la RLS del estudio.
import type { TxConsulta } from "../compras/errores";
import {
  ARGUMENTO_INVALIDO,
  consultarGastos,
  exigirBooleano,
  exigirId,
  exigirTexto,
  exigirTextos,
  exigirVersion,
  GastosRepoError,
} from "./errores";

export interface GastosEstudioLeido {
  /** 3 si el estudio no fijó uno. */
  umbral: number;
  /** 0 si el estudio no fijó uno. */
  versionUmbral: number;
  /** Propias activas (cuentan para el límite de 2.000). */
  activasPropias: number;
  /** Globales activas, por palabra ascendente. */
  globales: {
    id: string;
    palabra: string;
    categoria: string;
    excepciones: string[];
    desactivadaPorEstudio: boolean;
  }[];
  /** Propias activas e inactivas, por palabra ascendente. */
  propias: {
    id: string;
    palabra: string;
    categoria: string;
    excepciones: string[];
    origen: "manual" | "aprendida";
    activa: boolean;
    version: number;
    autor: { id: string; nombre: string };
    compraOrigenId: string | null;
    creadaEn: Date;
  }[];
}

const SQL_CONFIG = `select coalesce((select c.umbral::int from gnd_config c), 3) as umbral,
  coalesce((select c.version from gnd_config c), 0) as version,
  (select count(*)::int from gnd_palabra_estudio p where p.activa) as activas`;

const SQL_GLOBALES = `select g.id, g.palabra, g.categoria, g.excepciones,
    exists (select 1 from gnd_global_desactivada d where d.palabra_global_id = g.id) as desactivada
  from gnd_palabra_global g where g.activa order by g.palabra`;

const SQL_PROPIAS = `select p.id, p.palabra, p.categoria, p.excepciones, p.origen, p.activa, p.version, p.creado_por,
    coalesce(u.nombre, '') as nombre, p.compra_origen_id, p.creada_en
  from gnd_palabra_estudio p left join usuario u on u.id = p.creado_por order by p.palabra`;

const SQL_AGREGAR =
  "select public.gnd_palabra_agregar($1::text, $2::text, $3::text[]) as id";
const SQL_ESTADO =
  "select public.gnd_palabra_estado($1::uuid, $2::boolean, $3::integer) as version";
const SQL_GLOBAL_ESTADO =
  "select public.gnd_global_estado($1::uuid, $2::boolean)";
const SQL_UMBRAL =
  "select public.gnd_umbral_fijar($1::integer, $2::integer) as version";

export async function leerGastosEstudio(
  tx: TxConsulta,
): Promise<GastosEstudioLeido> {
  const [c] = await consultarGastos(tx, SQL_CONFIG, []);
  const globales = await consultarGastos(tx, SQL_GLOBALES, []);
  const propias = await consultarGastos(tx, SQL_PROPIAS, []);
  return {
    umbral: Number(c?.umbral ?? 3),
    versionUmbral: Number(c?.version ?? 0),
    activasPropias: Number(c?.activas ?? 0),
    globales: globales.map((g) => ({
      id: g.id as string,
      palabra: g.palabra as string,
      categoria: g.categoria as string,
      excepciones: (g.excepciones as string[] | null) ?? [],
      desactivadaPorEstudio: g.desactivada === true,
    })),
    propias: propias.map((p) => ({
      id: p.id as string,
      palabra: p.palabra as string,
      categoria: p.categoria as string,
      excepciones: (p.excepciones as string[] | null) ?? [],
      origen: p.origen as "manual" | "aprendida",
      activa: p.activa === true,
      version: Number(p.version),
      autor: { id: p.creado_por as string, nombre: p.nombre as string },
      compraOrigenId: (p.compra_origen_id as string | null) ?? null,
      creadaEn: p.creada_en as Date,
    })),
  };
}

/** `gnd_palabra_agregar`: devuelve el id de la palabra nueva (versión 1). */
export async function agregarPalabra(
  tx: TxConsulta,
  e: { palabra: string; categoria: string; excepciones?: string[] },
): Promise<string> {
  const palabra = exigirTexto(e.palabra);
  const categoria = exigirTexto(e.categoria);
  const excepciones = exigirTextos(e.excepciones ?? []);
  const [f] = await consultarGastos(tx, SQL_AGREGAR, [
    palabra,
    categoria,
    excepciones,
  ]);
  return f!.id as string;
}

/** `gnd_palabra_estado`: devuelve la versión nueva. */
export async function cambiarEstadoPalabra(
  tx: TxConsulta,
  e: { id: string; activa: boolean; version: number },
): Promise<number> {
  const id = exigirId(e.id);
  const activa = exigirBooleano(e.activa);
  const version = exigirVersion(e.version);
  const [f] = await consultarGastos(tx, SQL_ESTADO, [id, activa, version]);
  return Number(f!.version);
}

/** `gnd_global_estado`: `activa = false` desactiva la global para el estudio; `true` la reactiva. */
export async function cambiarEstadoGlobal(
  tx: TxConsulta,
  e: { palabraGlobalId: string; activa: boolean },
): Promise<void> {
  const id = exigirId(e.palabraGlobalId);
  const activa = exigirBooleano(e.activa);
  await consultarGastos(tx, SQL_GLOBAL_ESTADO, [id, activa]);
}

/** `gnd_umbral_fijar`: devuelve la versión nueva (`version` = la vigente; 0 si nunca se fijó). */
export async function fijarUmbral(
  tx: TxConsulta,
  e: { umbral: number; version: number },
): Promise<number> {
  if (
    typeof e.umbral !== "number" ||
    !Number.isInteger(e.umbral) ||
    e.umbral < 1 ||
    e.umbral > 20
  )
    throw new GastosRepoError(ARGUMENTO_INVALIDO);
  const version = exigirVersion(e.version);
  const [f] = await consultarGastos(tx, SQL_UMBRAL, [e.umbral, version]);
  return Number(f!.version);
}
