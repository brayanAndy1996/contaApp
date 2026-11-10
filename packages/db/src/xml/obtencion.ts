// Estado de obtención del XML por comprobante (spec 016, D-4, D-10, CA-10): `documento_xml_obtencion` es la única tabla de 016
// que se actualiza (una fila por comprobante, upsert). Lo escriben el worker (`xml.obtener`) y el backend («Obtener» de la lupa);
// lo leen la planificación de lotes tras la descarga y la lupa. Solo SQL estático y parametrizado.
import { consultar, type TxConsulta } from "../compras/errores";
import { normalizarIdentidadXml, type IdentidadXml } from "./documentos";

export const ESTADOS_OBTENCION = [
  "pendiente",
  "no_encontrado",
  "credencial",
  "transitorio",
] as const;
export type EstadoObtencionXml = (typeof ESTADOS_OBTENCION)[number];

/**
 * Estado efectivo: un `pendiente` sin novedades por más de 1 h cuenta como `transitorio` (el trabajo se perdió; plan, «BD»), para
 * que la planificación lo vuelva a pedir y la lupa no lo muestre en curso para siempre. Expresión sobre el alias `o`.
 */
const ESTADO_EFECTIVO = `case when o.estado = 'pendiente' and o.actualizado_en < now() - interval '1 hour' then 'transitorio'
    else o.estado end`;

// `intentos` cuenta los resultados (todo estado salvo `pendiente`, que marca la solicitud).
const SQL_FIJAR = `insert into documento_xml_obtencion as o (cliente_id, ruc_emisor, tipo, serie, numero, estado, intentos,
    actualizado_en)
  values ($1, $2, $3, $4, $5, $6, case when $6 = 'pendiente' then 0 else 1 end, now())
  on conflict (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero) do update
    set estado = excluded.estado, actualizado_en = now(),
        intentos = o.intentos + case when excluded.estado = 'pendiente' then 0 else 1 end`;

/**
 * Fija el estado de obtención del comprobante de ese cliente (crea la fila o la actualiza). Un estado fuera del catálogo lo
 * rechaza el CHECK de 0035 (ComprasRepoError 23514) y no escribe nada; un cliente ajeno, la FK compuesta (23503).
 */
export async function fijarObtencion(
  tx: TxConsulta,
  clienteId: string,
  identidad: IdentidadXml,
  estado: EstadoObtencionXml,
): Promise<void> {
  const i = normalizarIdentidadXml(identidad);
  await consultar(tx, SQL_FIJAR, [
    clienteId,
    i.rucEmisor,
    i.tipo,
    i.serie,
    i.numero,
    estado,
  ]);
}

export interface ObtencionXml {
  /** Estado efectivo (un `pendiente` de más de 1 h se lee `transitorio`). */
  estado: EstadoObtencionXml;
  intentos: number;
  actualizadoEn: Date;
}

const SQL_LEER = `select ${ESTADO_EFECTIVO} as estado, o.intentos, o.actualizado_en from documento_xml_obtencion o
  where o.cliente_id = $1 and o.ruc_emisor = $2 and o.tipo = $3 and o.serie = $4 and o.numero = $5`;

/** El estado de obtención del comprobante, o `null` si nadie lo pidió. */
export async function leerObtencion(
  tx: TxConsulta,
  clienteId: string,
  identidad: IdentidadXml,
): Promise<ObtencionXml | null> {
  const i = normalizarIdentidadXml(identidad);
  const f = (
    await consultar(tx, SQL_LEER, [
      clienteId,
      i.rucEmisor,
      i.tipo,
      i.serie,
      i.numero,
    ])
  ).rows[0];
  return f === undefined
    ? null
    : {
        estado: f.estado,
        intentos: f.intentos,
        actualizadoEn: f.actualizado_en,
      };
}

/** Una compra del periodo para planificar la obtención de su XML (la entrada de `planificarObtencionXml` del dominio). */
export interface FilaPorObtener {
  compraId: string;
  /** La última evaluación de la versión vigente tiene hallazgos. */
  conHallazgos: boolean;
  /** Hay un `documento_xml` del comprobante (de cualquier origen). */
  tieneXml: boolean;
  /** Estado efectivo de obtención, o `null` si nunca se pidió. */
  obtencion: EstadoObtencionXml | null;
}

/** Tipos de comprobante con XML (01, 03, 07, 08) y proveedor con RUC (doc 6): fuera de eso el XML es `no_aplica`. */
const SQL_POR_OBTENER = `select c.id as compra_id,
    exists (select 1 from compra_hallazgo h where h.tenant_id = c.tenant_id and h.compra_id = c.id
      and h.version_n = c.version_vigente and h.evaluacion_n = (select max(e.n) from compra_evaluacion e
        where e.tenant_id = c.tenant_id and e.compra_id = c.id and e.version_n = c.version_vigente)) as con_hallazgos,
    exists (select 1 from documento_xml d where d.tenant_id = c.tenant_id and d.cliente_id = c.cliente_id
      and d.ruc_emisor = c.doc_numero and d.tipo = c.tipo_doc and d.serie = upper(c.serie)
      and d.numero = coalesce(nullif(ltrim(c.numero, '0'), ''), '0')) as tiene_xml,
    (select ${ESTADO_EFECTIVO} from documento_xml_obtencion o where o.tenant_id = c.tenant_id and o.cliente_id = c.cliente_id
      and o.ruc_emisor = c.doc_numero and o.tipo = c.tipo_doc and o.serie = upper(c.serie)
      and o.numero = coalesce(nullif(ltrim(c.numero, '0'), ''), '0')) as obtencion
  from compra c
  where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null
    and c.tipo_doc in ('01', '03', '07', '08') and c.doc_tipo = '6'
  order by c.fecha, c.serie collate "C", lpad(c.numero, 20, '0') collate "C", c.id`;

/**
 * Las compras vivas del cliente y periodo a las que se les puede pedir XML (tipo 01/03/07/08 y proveedor con RUC), con lo que
 * necesita `planificarObtencionXml`: hallazgos vigentes, si ya hay XML y el estado de obtención efectivo. Orden de la grilla.
 */
export async function listarPorObtener(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
): Promise<FilaPorObtener[]> {
  const r = await consultar(tx, SQL_POR_OBTENER, [clienteId, periodo]);
  return r.rows.map((f) => ({
    compraId: f.compra_id,
    conHallazgos: f.con_hallazgos,
    tieneXml: f.tiene_xml,
    obtencion: f.obtencion ?? null,
  }));
}
