// Re-evaluación de compras cuando llega o cambia el XML de su comprobante (spec 016, D-4, D-5, D-7, P-2, CA-6 a CA-8). No crea
// versión ni mueve el puntero: inserta la evaluación `n + 1` de la versión vigente con sus hallazgos, así `versionBase`, deshacer y
// las ediciones en curso no cambian. Vale en cualquier estado del periodo (no cambia montos).
//
// ORDEN DE BLOQUEO (plan 016, 014 ampliado): [advisory del comprobante: lo toma `guardarDocumentoXml`, antes] -> `compra_periodo`
// FOR SHARE (por periodo ascendente) -> `compra` FOR UPDATE (por id ascendente). No se toma ninguna `compra_operacion` (no hay
// operación) ni otro advisory después.
//
// H-016-8: el worker no tiene UPDATE sobre `compra` (0038), así que no puede `SELECT … FOR UPDATE`; bloquea con la función acotada
// `bloquear_compras_reevaluar` (SECURITY DEFINER, mismo modo de bloqueo y mismo orden). El backend, que sí tiene el privilegio,
// bloquea la fila directamente (`bloqueo: "fila"`).
import {
  consultar,
  ComprasReglaError,
  type TxConsulta,
} from "../compras/errores";
import {
  esUuid,
  guardarEvaluaciones,
  leerCompra,
  xmlDeCompras,
} from "../compras/repositorio";
import type { CompraLeida, Evaluar } from "../compras/tipos";
import { normalizarIdentidadXml, type IdentidadXml } from "./documentos";

/**
 * Cómo se bloquean las compras: `funcion` (worker, sin UPDATE sobre `compra`), `fila` (backend, FOR UPDATE directo) o `auto`
 * (por omisión: `fila` si el rol de la sesión tiene UPDATE en alguna columna de `compra`, si no `funcion`).
 */
export type BloqueoReevaluar = "funcion" | "fila" | "auto";

const SQL_PERIODOS_COMPARTIDOS = `select 1 from compra_periodo where cliente_id = $1 and periodo = any($2::char(6)[])
  order by periodo for share`;

const SQL_BLOQUEAR_FILAS = `select id from compra where id = any($1::uuid[]) and descartada_en is null order by id for update`;

const SQL_BLOQUEAR_FUNCION = `select id from public.bloquear_compras_reevaluar($1::uuid[]) as b(id)`;

const SQL_PUEDE_BLOQUEAR = `select has_any_column_privilege('public.compra', 'UPDATE') as puede`;

const SQL_SIGUIENTE = `select coalesce(max(n), 0) + 1 as n from compra_evaluacion where compra_id = $1 and version_n = $2`;

// Las compras vivas del cliente cuyo comprobante es el del XML, con la normalización de `normalizarIdentidadXml` (RUC y tipo sin
// espacios, serie en mayúsculas y número sin ceros a la izquierda), en cualquier periodo.
const SQL_DEL_COMPROBANTE = `select id, periodo from compra
  where cliente_id = $1 and descartada_en is null and btrim(doc_numero) = $2 and btrim(tipo_doc) = $3
    and upper(btrim(serie)) = $4 and regexp_replace(btrim(numero), '^0+(?=.)', '') = $5
  order by id`;

export interface ResultadoReevaluar {
  /** La versión evaluada (la vigente, ya bloqueada). */
  version: number;
  /** Número de la evaluación insertada. */
  n: number;
  /** El XML con el que se evaluó, o `null`. */
  documentoXmlId: string | null;
}

/** Lo que recibe `reevaluarComprobante`: la evaluación de cada periodo (su historial de proveedores) y cómo bloquear. */
export interface FuncionesReevaluar {
  /** Las reglas con el entorno del periodo de la compra (el historial de proveedores depende del periodo). */
  evaluarDe: (periodo: string) => Promise<Evaluar> | Evaluar;
  bloqueo?: BloqueoReevaluar;
}

/** Bloquea las compras vivas de `ids` en orden de id y devuelve las que quedaron bloqueadas. */
async function bloquear(
  tx: TxConsulta,
  ids: string[],
  bloqueo: BloqueoReevaluar,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const directo =
    bloqueo === "auto"
      ? ((await consultar(tx, SQL_PUEDE_BLOQUEAR, [])).rows[0]!
          .puede as boolean)
      : bloqueo === "fila";
  const r = await consultar(
    tx,
    directo ? SQL_BLOQUEAR_FILAS : SQL_BLOQUEAR_FUNCION,
    [ids],
  );
  return new Set(r.rows.map((f) => f.id as string));
}

/**
 * Re-evalúa (evaluación nueva de la versión vigente) cada compra de `previas` que siga viva después de bloquear, con el XML
 * vigente de su comprobante leído DESPUÉS del bloqueo. Devuelve el resultado por compra; las que ya no están vivas no salen.
 */
async function reevaluarBloqueando(
  tx: TxConsulta,
  clienteId: string,
  previas: { id: string; periodo: string }[],
  f: FuncionesReevaluar,
): Promise<Map<string, ResultadoReevaluar>> {
  const salida = new Map<string, ResultadoReevaluar>();
  if (previas.length === 0) return salida;
  const periodos = [...new Set(previas.map((p) => p.periodo))].sort();
  await consultar(tx, SQL_PERIODOS_COMPARTIDOS, [clienteId, periodos]);
  const ids = [...new Set(previas.map((p) => p.id))].sort();
  const bloqueadas = await bloquear(tx, ids, f.bloqueo ?? "auto");
  // Relee la versión vigente ya bloqueada: si otra transacción creó una versión mientras esperábamos, se evalúa esa.
  const actuales: CompraLeida[] = [];
  for (const id of ids) {
    if (!bloqueadas.has(id)) continue;
    const actual = await leerCompra(tx, id, false);
    if (actual !== null) actuales.push(actual);
  }
  const xmls = await xmlDeCompras(tx, actuales);
  for (const actual of actuales) {
    const xml = xmls.get(actual.id) ?? null;
    const n = (await consultar(tx, SQL_SIGUIENTE, [actual.id, actual.version]))
      .rows[0]!.n as number;
    await guardarEvaluaciones(
      tx,
      [{ fila: actual, n, xml }],
      await f.evaluarDe(actual.periodo),
    );
    salida.set(actual.id, {
      version: actual.version,
      n,
      documentoXmlId: xml?.id ?? null,
    });
  }
  return salida;
}

/**
 * Re-evalúa la versión vigente de la compra con el XML vigente de su comprobante, leído en esta misma transacción después de
 * bloquear la fila. `no_encontrada` (ComprasReglaError) si la compra no existe, es de otro estudio o está descartada. Si
 * `evaluar` lanza, se propaga y no queda nada escrito. Por omisión el modo de bloqueo se elige por el privilegio del rol (`auto`).
 */
export async function reevaluarCompra(
  tx: TxConsulta,
  compraId: string,
  f: { evaluar: Evaluar; bloqueo?: BloqueoReevaluar },
): Promise<ResultadoReevaluar> {
  if (!esUuid(compraId)) throw new ComprasReglaError("no_encontrada");
  // Cliente y periodo para bloquear primero el periodo; esta lectura no bloquea.
  const previa = await leerCompra(tx, compraId, false);
  if (!previa) throw new ComprasReglaError("no_encontrada");
  const r = await reevaluarBloqueando(
    tx,
    previa.clienteId,
    [{ id: previa.id, periodo: previa.periodo }],
    {
      evaluarDe: () => f.evaluar,
      ...(f.bloqueo === undefined ? {} : { bloqueo: f.bloqueo }),
    },
  );
  const hecho = r.get(previa.id);
  if (hecho === undefined) throw new ComprasReglaError("no_encontrada");
  return hecho;
}

/**
 * H-016-11: re-evalúa TODAS las compras vivas de un comprobante (mismo cliente e identidad, en cualquier periodo), porque el XML
 * vigente es del comprobante (D-4): se llama cuando llega o se sube su XML, después de `guardarDocumentoXml` (que tomó el advisory
 * del comprobante). `excluir` deja fuera compras ya evaluadas con ese XML en esta transacción (la que se acaba de crear). Devuelve
 * el resultado por id de compra; una descartada, de otro cliente o de otro estudio no se toca.
 */
export async function reevaluarComprobante(
  tx: TxConsulta,
  clienteId: string,
  identidad: IdentidadXml,
  f: FuncionesReevaluar & { excluir?: readonly string[] },
): Promise<Map<string, ResultadoReevaluar>> {
  const i = normalizarIdentidadXml(identidad);
  const fuera = new Set((f.excluir ?? []).map((x) => x.toLowerCase()));
  const previas = (
    await consultar(tx, SQL_DEL_COMPROBANTE, [
      clienteId,
      i.rucEmisor,
      i.tipo,
      i.serie,
      i.numero,
    ])
  ).rows
    .map((x) => ({ id: x.id as string, periodo: x.periodo as string }))
    .filter((x) => !fuera.has(x.id));
  return reevaluarBloqueando(tx, clienteId, previas, f);
}
