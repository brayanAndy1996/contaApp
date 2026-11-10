// Lecturas de compras para el backend (spec 014, D-4, D-8, D-13): listado con cursor y filtros, detalle con versiones y
// hallazgos, y lotes del periodo para el resumen. Solo SQL estático y parametrizado: ningún dato (ni `q`) entra en el texto; los
// comodines de `q` se escapan aquí. Los NUMERIC se leen con `::text` (cadenas exactas); nada pasa por `number`.
import { consultar, type Fila, type TxConsulta } from "./errores";
import {
  aCompraLeida,
  COLUMNAS_LEIDA,
  esUuid,
  montosDe,
  UNION_VIGENTE,
} from "./repositorio";
import type { CompraLeida, MontosCompra } from "./tipos";

export type VistaListado = "con_igv" | "sin_igv" | "excluidas";

/** Posición en el orden fecha, serie, número, id: la fila después de la cual sigue la página. */
export interface CursorListado {
  fecha: string;
  serie: string;
  numero: string;
  id: string;
}

export interface FiltrosListado {
  cursor?: CursorListado;
  /** 1 a 5.000. */
  limite: number;
  vista?: VistaListado;
  alertas?: boolean;
  proveedorNuevo?: boolean;
  q?: string;
}

/** Hallazgo guardado de la versión vigente de una compra. */
export interface HallazgoGuardadoFila {
  compraId: string;
  regla: string;
  sugerencia: unknown;
  lecturas: Record<string, string>;
  requiereConfirmacion: boolean;
}

export interface CompraListada {
  compra: CompraLeida;
  proveedorNuevo: boolean;
  hallazgos: HallazgoGuardadoFila[];
}

export interface PaginaListado {
  filas: CompraListada[];
  siguiente: CursorListado | null;
}

/**
 * La compra tiene proveedor nuevo si no está clasificada y el mismo cliente no tiene compras vivas o excluidas (las descartadas
 * no) del mismo proveedor en OTROS periodos (D-4, DU-7). Una agregada viva de otro periodo también cuenta.
 */
const PROVEEDOR_NUEVO = `(not v.clasificada and not exists (
    select 1 from compra h where h.cliente_id = c.cliente_id and h.periodo <> c.periodo and h.descartada_en is null
      and h.doc_tipo = c.doc_tipo and h.doc_numero = c.doc_numero))`;

/** Suma de los tres IGV de la versión vigente distinta de 0.00. */
const CON_IGV = `(v.igv_dg + v.igv_dgng + v.igv_dng) <> 0`;

/**
 * La versión vigente de `c` por búsqueda de índice `(tenant_id, compra_id, n)`. `offset 0` impide que el planificador aplane la
 * subconsulta y, con estadísticas todavía viejas (la descarga acaba de insertar miles de filas), elija recorrer el índice
 * entero por cada compra: con 5.000 filas eran 12 millones de comparaciones.
 */
const VERSION_VIGENTE_LATERAL = `(select * from compra_version x where x.tenant_id = c.tenant_id and x.compra_id = c.id
    and x.n = c.version_vigente offset 0)`;
const VERSION_UNO_LATERAL = `(select * from compra_version x where x.tenant_id = c.tenant_id and x.compra_id = c.id
    and x.n = 1 offset 0)`;

/**
 * Número de la última evaluación de la versión vigente de `c` (016 D-5): los hallazgos vigentes son los suyos. Búsqueda por el
 * índice único `(tenant_id, compra_id, version_n, n)` recorrido al revés.
 */
const ULTIMA_EVALUACION = `(select max(e.n) from compra_evaluacion e where e.tenant_id = c.tenant_id and e.compra_id = c.id
    and e.version_n = c.version_vigente)`;

/** Número con ceros a la izquierda para ordenar «999» antes de «1000» (el número tiene hasta 15 caracteres). */
const NUMERO_ORDEN = `lpad(c.numero, 20, '0') collate "C"`;
const SERIE_ORDEN = `c.serie collate "C"`;

/**
 * El listado calcula los proveedores conocidos UNA vez (el cliente en otros periodos) y los cruza con un anti-join por hash, en
 * lugar de una subconsulta correlacionada por fila, que con 5.000 filas recorre el historial 5.000 veces (CA-15).
 */
const SQL_LISTADO = `with conocidos as materialized (
  select distinct doc_tipo, doc_numero from compra where cliente_id = $1 and periodo <> $2 and descartada_en is null
)
select * from (
  select ${COLUMNAS_LEIDA},
    (not v.clasificada and not exists (select 1 from conocidos k where k.doc_tipo = c.doc_tipo and k.doc_numero = c.doc_numero))
      as proveedor_nuevo, ${SERIE_ORDEN} as orden_serie, ${NUMERO_ORDEN} as orden_numero,
    c.fecha as orden_fecha,
    exists (select 1 from compra_hallazgo z where z.tenant_id = c.tenant_id and z.compra_id = c.id
      and z.version_n = c.version_vigente and z.evaluacion_n = ${ULTIMA_EVALUACION}) as con_hallazgos
  from compra c cross join lateral ${VERSION_VIGENTE_LATERAL} v
  where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null
    and (case when $3::text = 'excluidas' then v.excluida else not v.excluida end)
    and (coalesce($3::text, '') not in ('con_igv', 'sin_igv') or (${CON_IGV}) = ($3::text = 'con_igv'))
    and (
      $9::text is null
      or c.doc_numero like $9::text escape '\\'
      or c.razon_social ilike $10::text escape '\\'
      or (c.serie || '-' || c.numero) ilike $10::text escape '\\'
    )
) t
where ($4::boolean is null or t.proveedor_nuevo = $4::boolean)
  and ($5::boolean is null or not $5::boolean or t.con_hallazgos)
  and ($6::date is null or t.orden_fecha > $6::date
    or (t.orden_fecha = $6::date and (t.orden_serie > $7::text collate "C"
      or (t.orden_serie = $7::text collate "C" and (t.orden_numero > lpad($8::text, 20, '0') collate "C"
        or (t.orden_numero = lpad($8::text, 20, '0') collate "C" and t.id > $11::uuid))))))
order by t.orden_fecha, t.orden_serie, t.orden_numero, t.id
limit $12`;

const SQL_ORIGENES = `select id, origen from compra
  where id = any($1::uuid[]) and cliente_id = $2 and periodo = $3 and descartada_en is null`;

/**
 * Origen (`sire` | `agregada`) de las compras vivas de ESE cliente y periodo entre `ids`; las que no existen, son de otro cliente,
 * periodo o estudio (RLS) o están descartadas no salen. Lo usa excluir en masa, donde una agregada se descarta (DU-16).
 */
export async function leerOrigenesCompras(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  ids: string[],
): Promise<Map<string, "sire" | "agregada">> {
  const mapa = new Map<string, "sire" | "agregada">();
  const validos = ids.filter(esUuid);
  if (validos.length === 0) return mapa;
  const r = await consultar(tx, SQL_ORIGENES, [validos, clienteId, periodo]);
  for (const f of r.rows) mapa.set(f.id as string, f.origen as "sire" | "agregada");
  return mapa;
}

/** `%`, `_` y `\` como texto literal en un LIKE. */
export const escaparLike = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

const SQL_HALLAZGOS = `select h.compra_id, h.regla, h.sugerencia, h.lecturas, h.requiere_confirmacion
  from compra c join compra_hallazgo h on h.tenant_id = c.tenant_id and h.compra_id = c.id and h.version_n = c.version_vigente
    and h.evaluacion_n = ${ULTIMA_EVALUACION}
  where c.id = any($1::uuid[])
  order by h.compra_id, array_position(array['R-ISC','R-MIX','R-RED','R-NEW','R-GP'], h.regla::text)`;

const aHallazgo = (f: Fila): HallazgoGuardadoFila => ({
  compraId: f.compra_id,
  regla: f.regla,
  sugerencia: f.sugerencia ?? null,
  lecturas: f.lecturas ?? {},
  requiereConfirmacion: f.requiere_confirmacion,
});

/** Los hallazgos vigentes de cada compra (los de la última evaluación de su versión vigente), en el orden de las reglas de 011. */
export async function leerHallazgosVigentes(
  tx: TxConsulta,
  compraIds: string[],
): Promise<Map<string, HallazgoGuardadoFila[]>> {
  const mapa = new Map<string, HallazgoGuardadoFila[]>();
  if (compraIds.length === 0) return mapa;
  const r = await consultar(tx, SQL_HALLAZGOS, [compraIds]);
  for (const f of r.rows) {
    const h = aHallazgo(f);
    const lista = mapa.get(h.compraId);
    if (lista === undefined) mapa.set(h.compraId, [h]);
    else lista.push(h);
  }
  return mapa;
}

/**
 * Una página del listado: compras vivas del cliente y periodo en la versión vigente, por fecha, serie y número (el número como
 * entero de hasta 15 caracteres, no como texto) y id. La lista principal no trae excluidas; `vista` las separa o divide por IGV.
 * `q` busca por prefijo de RUC, fragmento de razón social o de serie-número, sin distinguir mayúsculas.
 */
export async function listarCompras(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  filtros: FiltrosListado,
): Promise<PaginaListado> {
  const q = filtros.q === undefined || filtros.q === "" ? null : escaparLike(filtros.q);
  const c = filtros.cursor;
  const r = await consultar(tx, SQL_LISTADO, [
    clienteId,
    periodo,
    filtros.vista ?? null,
    filtros.proveedorNuevo ?? null,
    filtros.alertas ?? null,
    c?.fecha ?? null,
    c?.serie ?? null,
    c?.numero ?? null,
    q === null ? null : `${q}%`,
    q === null ? null : `%${q}%`,
    c?.id ?? null,
    filtros.limite + 1,
  ]);
  const hayMas = r.rows.length > filtros.limite;
  const filas = hayMas ? r.rows.slice(0, filtros.limite) : r.rows;
  const hallazgos = await leerHallazgosVigentes(tx, filas.map((f) => f.id as string));
  const salida = filas.map((f) => ({
    compra: aCompraLeida(f),
    proveedorNuevo: f.proveedor_nuevo as boolean,
    hallazgos: hallazgos.get(f.id) ?? [],
  }));
  const ultima = salida[salida.length - 1];
  return {
    filas: salida,
    siguiente:
      hayMas && ultima !== undefined
        ? { fecha: ultima.compra.fecha, serie: ultima.compra.serie, numero: ultima.compra.numero, id: ultima.compra.id }
        : null,
  };
}

/** Una versión de la compra con sus montos y quién la hizo (historial). */
export interface VersionHistorial {
  n: number;
  accion: string;
  operacionId: string | null;
  usuarioId: string | null;
  creadaEn: Date;
  excluida: boolean;
  motivo: string | null;
  clasificada: boolean;
  montos: MontosCompra;
}

export interface DetalleLeido {
  compra: CompraLeida;
  proveedorNuevo: boolean;
  versiones: VersionHistorial[];
  hallazgos: HallazgoGuardadoFila[];
}

const SQL_DETALLE = `select ${COLUMNAS_LEIDA}, ${PROVEEDOR_NUEVO} as proveedor_nuevo from ${UNION_VIGENTE}
  where c.id = $1 and c.cliente_id = $2 and c.periodo = $3 and c.descartada_en is null`;
const SQL_VERSIONES = `select v.n, v.accion, v.operacion_id, v.usuario_id, v.creada_en, v.excluida, v.motivo, v.clasificada,
    v.bi_dg::text as bi_dg, v.igv_dg::text as igv_dg, v.bi_dgng::text as bi_dgng, v.igv_dgng::text as igv_dgng,
    v.bi_dng::text as bi_dng, v.igv_dng::text as igv_dng, v.no_gravado::text as no_gravado, v.isc::text as isc,
    v.icbper::text as icbper, v.otros_tributos::text as otros_tributos, v.total::text as total
  from compra_version v where v.compra_id = $1 order by v.n`;

/**
 * La compra viva con su historial de versiones y los hallazgos de la vigente, o `null` si no existe, es de otro cliente, periodo
 * o estudio (RLS), está descartada o el id está mal formado.
 */
export async function leerDetalleCompra(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  compraId: string,
): Promise<DetalleLeido | null> {
  if (!esUuid(compraId)) return null;
  const c = await consultar(tx, SQL_DETALLE, [compraId, clienteId, periodo]);
  const fila = c.rows[0];
  if (fila === undefined) return null;
  const v = await consultar(tx, SQL_VERSIONES, [compraId]);
  const hallazgos = await leerHallazgosVigentes(tx, [compraId]);
  return {
    compra: aCompraLeida(fila),
    proveedorNuevo: fila.proveedor_nuevo as boolean,
    versiones: v.rows.map((f) => ({
      n: f.n,
      accion: f.accion,
      operacionId: f.operacion_id,
      usuarioId: f.usuario_id,
      creadaEn: f.creada_en,
      excluida: f.excluida,
      motivo: f.motivo,
      clasificada: f.clasificada,
      montos: montosDe(f),
    })),
    hallazgos: hallazgos.get(compraId) ?? [],
  };
}

/** Una compra del periodo con su versión 1 y su vigente, para acumular el resumen. */
export interface CompraParaResumen {
  id: string;
  origen: "sire" | "agregada";
  moneda: "PEN" | "USD";
  tipoCambio: string | null;
  excluida: boolean;
  original: MontosCompra;
  vigente: MontosCompra;
}

const COLUMNAS_PREFIJO = (p: string, alias: string): string =>
  ["bi_dg", "igv_dg", "bi_dgng", "igv_dgng", "bi_dng", "igv_dng", "no_gravado", "isc", "icbper", "otros_tributos", "total"]
    .map((k) => `${alias}.${k}::text as ${p}${k}`)
    .join(", ");

const SQL_LOTE = `select c.id, c.origen, c.moneda, c.tipo_cambio::text as tipo_cambio, vv.excluida,
    ${COLUMNAS_PREFIJO("o_", "v1")}, ${COLUMNAS_PREFIJO("v_", "vv")}
  from compra c
    cross join lateral ${VERSION_UNO_LATERAL} v1
    cross join lateral ${VERSION_VIGENTE_LATERAL} vv
  where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null and ($3::uuid is null or c.id > $3::uuid)
  order by c.id limit $4`;

const conPrefijo = (f: Fila, p: string): MontosCompra =>
  montosDe({
    bi_dg: f[`${p}bi_dg`],
    igv_dg: f[`${p}igv_dg`],
    bi_dgng: f[`${p}bi_dgng`],
    igv_dgng: f[`${p}igv_dgng`],
    bi_dng: f[`${p}bi_dng`],
    igv_dng: f[`${p}igv_dng`],
    no_gravado: f[`${p}no_gravado`],
    isc: f[`${p}isc`],
    icbper: f[`${p}icbper`],
    otros_tributos: f[`${p}otros_tributos`],
    total: f[`${p}total`],
  });

/** Un lote de las compras vivas del periodo, por id ascendente a partir de `despuesDe`: se pide hasta que llegue vacío. */
export async function leerLoteParaResumen(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  despuesDe: string | null,
  tamano: number,
): Promise<CompraParaResumen[]> {
  const r = await consultar(tx, SQL_LOTE, [clienteId, periodo, despuesDe, tamano]);
  return r.rows.map((f) => ({
    id: f.id,
    origen: f.origen,
    moneda: f.moneda,
    tipoCambio: f.tipo_cambio,
    excluida: f.excluida,
    original: conPrefijo(f, "o_"),
    vigente: conPrefijo(f, "v_"),
  }));
}
