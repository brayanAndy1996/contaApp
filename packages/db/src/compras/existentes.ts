// Lecturas de compras para el persistidor de la descarga (spec 014, D-4, D-18). Solo SQL estático dentro de la tx de `withTenant`.
import { consultar, type TxConsulta } from "./errores";
import { UNION_ORIGINAL } from "./repositorio";
import type { ExistenteCompra, ProveedorConocido } from "./tipos";

// `campos` salen SIEMPRE de la versión 1 (el original que trajo el SIRE), nunca de la vigente: la descarga repetida compara contra
// lo que el SIRE entregó, no contra lo que el usuario corrigió después.
const SQL_EXISTENTES = `select c.clave, c.origen, to_char(c.fecha, 'YYYY-MM-DD') as fecha, c.moneda,
    coalesce(c.tipo_cambio::text, '') as tipo_cambio, c.doc_tipo, c.doc_numero,
    v.bi_dg::text as bi_dg, v.igv_dg::text as igv_dg, v.bi_dgng::text as bi_dgng, v.igv_dgng::text as igv_dgng,
    v.bi_dng::text as bi_dng, v.igv_dng::text as igv_dng, v.no_gravado::text as no_gravado, v.isc::text as isc,
    v.icbper::text as icbper, v.otros_tributos::text as otros_tributos, v.total::text as total
  from ${UNION_ORIGINAL}
  where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null
  order by c.clave, c.id`;

/**
 * Las compras vivas del periodo (las excluidas incluidas, las descartadas no) en la forma que compara `planificarComplemento` de
 * 013. `agregada` se informa como `manual`. `campos` (todas cadenas con la escala de la columna): `fecha`, `moneda`, `tipoCambio`
 * (`''` si no hay), `docTipo` y `docNumero` del proveedor, las 10 columnas de monto y `total`; nunca la razón social (D-18). Se
 * llama con el advisory `(cliente, periodo, 'compras')` ya tomado. Se llama `leerExistentesCompras` porque 013 ya exporta
 * `leerExistentes` para ventas.
 */
export async function leerExistentesCompras(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
): Promise<ExistenteCompra[]> {
  const r = await consultar(tx, SQL_EXISTENTES, [clienteId, periodo]);
  return r.rows.map((f) => ({
    clave: f.clave,
    origen: f.origen === "agregada" ? "manual" : "sire",
    campos: {
      fecha: f.fecha,
      moneda: f.moneda,
      tipoCambio: f.tipo_cambio,
      docTipo: f.doc_tipo,
      docNumero: f.doc_numero,
      biDg: f.bi_dg,
      igvDg: f.igv_dg,
      biDgng: f.bi_dgng,
      igvDgng: f.igv_dgng,
      biDng: f.bi_dng,
      igvDng: f.igv_dng,
      noGravado: f.no_gravado,
      isc: f.isc,
      icbper: f.icbper,
      otrosTributos: f.otros_tributos,
      total: f.total,
    },
  }));
}

const SQL_PROVEEDORES = `select doc_tipo as tipo, doc_numero as numero from compra
  where cliente_id = $1 and periodo <> $2 and descartada_en is null
  group by doc_tipo, doc_numero order by doc_tipo, doc_numero`;

/**
 * Documentos distintos de los proveedores de las compras vivas o excluidas del cliente en OTROS periodos (D-4, DU-7): quien no
 * figura aquí es proveedor nuevo. Sin historial: `[]`.
 */
export async function leerProveedoresConocidos(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
): Promise<ProveedorConocido[]> {
  const r = await consultar(tx, SQL_PROVEEDORES, [clienteId, periodo]);
  return r.rows.map((f) => ({ tipo: f.tipo, numero: f.numero }));
}
