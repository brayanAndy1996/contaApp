// XML de los comprobantes (spec 016, D-4, P-6): guardar y leer `documento_xml`. Solo SQL estático y parametrizado; el `detalle`
// (el `DetalleXml` del dominio) viaja como un solo jsonb y se devuelve opaco. `packages/db` no parsea XML ni toca el storage:
// recibe la ruta, el hash y el tamaño ya calculados. Ningún error lleva el contenido (D-11): todo sale como ComprasRepoError.
//
// Orden de bloqueo (plan 016): el advisory del comprobante se toma ANTES que cualquier bloqueo de compras; ninguna transacción lo
// toma después de bloquear una `compra` (quien guarda y re-evalúa llama primero a `guardarDocumentoXml`).
import { consultar, type TxConsulta } from "../compras/errores";
import type { OrigenDocumentoXml, XmlParaEvaluar } from "../compras/tipos";

/** Identidad de un comprobante para su XML: RUC del emisor, tipo, serie y número. */
export interface IdentidadXml {
  rucEmisor: string;
  tipo: string;
  serie: string;
  numero: string;
}

/** Lo que se guarda de un XML ya validado y escrito en storage. */
export interface EntradaDocumentoXml extends IdentidadXml {
  clienteId: string;
  origen: OrigenDocumentoXml;
  /** `xml/{tenant}/{cliente}/{uuid}.xml` (lo arma `packages/storage`). */
  ruta: string;
  /** SHA-256 de los bytes guardados (32 bytes). */
  sha256: Uint8Array;
  /** Bytes; hasta 1 MiB. */
  tamano: number;
  /** `DetalleXml` del parser; se guarda tal cual. */
  detalle: unknown;
  /** Usuario que lo subió: obligatorio si y solo si `origen` es `subido` (CHECK de 0035). */
  subidoPor?: string | null;
}

export type ResultadoGuardarXml =
  { id: string; n: number } | "existente_no_simulado";

/** El XML vigente (mayor `n`) de un comprobante. */
export interface XmlVigente {
  id: string;
  n: number;
  origen: OrigenDocumentoXml;
  detalle: unknown;
  ruta: string;
  /** SHA-256 en hexadecimal. */
  sha256: string;
  tamano: number;
  subidoPor: string | null;
  creadaEn: Date;
}

/** Serie en mayúsculas y número sin ceros a la izquierda: la misma normalización que la `clave` de 014. */
export const normalizarIdentidadXml = (i: IdentidadXml): IdentidadXml => ({
  rucEmisor: String(i.rucEmisor).trim(),
  tipo: String(i.tipo).trim(),
  serie: String(i.serie).trim().toUpperCase(),
  numero: String(i.numero)
    .trim()
    .replace(/^0+(?=.)/, ""),
});

/** Clave del advisory del comprobante (lo toman guardar y la subida antes que cualquier bloqueo de compras). */
const claveAdvisory = (clienteId: string, i: IdentidadXml): string =>
  `xml:${clienteId}:${i.rucEmisor}|${i.tipo}|${i.serie}|${i.numero}`;

const SQL_BLOQUEAR = `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`;

const DONDE_COMPROBANTE = `cliente_id = $1 and ruc_emisor = $2 and tipo = $3 and serie = $4 and numero = $5`;

const SQL_ULTIMO = `select n, origen from documento_xml where ${DONDE_COMPROBANTE} order by n desc limit 1`;

const SQL_INSERTAR = `insert into documento_xml (cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano,
    detalle, subido_por)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
  returning id, n`;

const SQL_VIGENTE = `select id, n, origen, detalle, ruta, encode(sha256, 'hex') as sha256, tamano, subido_por, creada_en
  from documento_xml where ${DONDE_COMPROBANTE} order by n desc limit 1`;

const parametros = (clienteId: string, i: IdentidadXml) => [
  clienteId,
  i.rucEmisor,
  i.tipo,
  i.serie,
  i.numero,
];

/**
 * Guarda un XML del comprobante (P-6). Toma el advisory del comprobante y decide con el vigente:
 *  - sin XML: inserta `n = 1`;
 *  - con uno `simulado` vigente y la entrada `subido`: inserta `n + 1` (el anterior se conserva);
 *  - en otro caso (`real` o `subido` vigente, o el worker con cualquier XML ya guardado): `"existente_no_simulado"` sin insertar.
 * Un cliente ajeno falla por la FK compuesta (ComprasRepoError 23503) y no queda nada.
 */
export async function guardarDocumentoXml(
  tx: TxConsulta,
  e: EntradaDocumentoXml,
): Promise<ResultadoGuardarXml> {
  const i = normalizarIdentidadXml(e);
  await consultar(tx, SQL_BLOQUEAR, [claveAdvisory(e.clienteId, i)]);
  const ultimo = (await consultar(tx, SQL_ULTIMO, parametros(e.clienteId, i)))
    .rows[0];
  if (
    ultimo !== undefined &&
    (ultimo.origen !== "simulado" || e.origen !== "subido")
  )
    return "existente_no_simulado";
  const n = ultimo === undefined ? 1 : (ultimo.n as number) + 1;
  const r = await consultar(tx, SQL_INSERTAR, [
    ...parametros(e.clienteId, i),
    n,
    e.origen,
    e.ruta,
    Buffer.from(e.sha256),
    e.tamano,
    JSON.stringify(e.detalle ?? null),
    e.subidoPor ?? null,
  ]);
  return { id: r.rows[0]!.id as string, n: r.rows[0]!.n as number };
}

/** El XML vigente (mayor `n`) del comprobante de ese cliente, o `null` (sin XML, otro cliente u otro estudio por RLS). */
export async function leerXmlVigente(
  tx: TxConsulta,
  clienteId: string,
  identidad: IdentidadXml,
): Promise<XmlVigente | null> {
  const i = normalizarIdentidadXml(identidad);
  const f = (await consultar(tx, SQL_VIGENTE, parametros(clienteId, i)))
    .rows[0];
  if (f === undefined) return null;
  return {
    id: f.id,
    n: f.n,
    origen: f.origen,
    detalle: f.detalle,
    ruta: f.ruta,
    sha256: f.sha256,
    tamano: f.tamano,
    subidoPor: f.subido_por,
    creadaEn: f.creada_en,
  };
}

/** Una compra para la que se busca el XML vigente (su identidad tal como está en `compra`). */
export interface ComprobanteDeCompra {
  compraId: string;
  clienteId: string;
  tipoDoc: string;
  serie: string;
  numero: string;
  docNumero: string;
}

/** El XML vigente que recibe `evaluar` y el id que guarda la evaluación. */
export interface XmlDeCompra {
  id: string;
  xml: XmlParaEvaluar;
}

const SQL_VIGENTES = `select x.compra_id, d.id, d.origen, d.detalle
  from jsonb_to_recordset($1::jsonb) as x(compra_id uuid, cliente_id uuid, ruc text, tipo text, serie text, numero text)
  cross join lateral (select y.id, y.origen, y.detalle from documento_xml y
    where y.cliente_id = x.cliente_id and y.ruc_emisor = x.ruc and y.tipo = x.tipo and y.serie = x.serie and y.numero = x.numero
    order by y.n desc limit 1) d`;

/** Filas por sentencia (mismo tope que los lotes de compras). */
const LOTE = 500;

/**
 * El XML vigente de cada compra (por su comprobante: RUC del proveedor, tipo, serie y número normalizados), en una sentencia por
 * lote. Las compras sin XML no salen del mapa. Quien llama ya bloqueó las filas, así que lo leído es lo confirmado tras el bloqueo.
 */
export async function leerXmlVigentesDeCompras(
  tx: TxConsulta,
  compras: ComprobanteDeCompra[],
): Promise<Map<string, XmlDeCompra>> {
  const mapa = new Map<string, XmlDeCompra>();
  for (let desde = 0; desde < compras.length; desde += LOTE) {
    const parte = compras.slice(desde, desde + LOTE).map((c) => {
      const i = normalizarIdentidadXml({
        rucEmisor: c.docNumero,
        tipo: c.tipoDoc,
        serie: c.serie,
        numero: c.numero,
      });
      return {
        compra_id: c.compraId,
        cliente_id: c.clienteId,
        ruc: i.rucEmisor,
        tipo: i.tipo,
        serie: i.serie,
        numero: i.numero,
      };
    });
    const r = await consultar(tx, SQL_VIGENTES, [JSON.stringify(parte)]);
    for (const f of r.rows)
      mapa.set(f.compra_id as string, {
        id: f.id as string,
        xml: { origen: f.origen, detalle: f.detalle },
      });
  }
  return mapa;
}
