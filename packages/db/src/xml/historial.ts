// Historial del proveedor en la lupa (spec 016, RF-094): las compras vivas o excluidas (no las descartadas) del MISMO cliente y
// proveedor en los 6 periodos anteriores al pedido, a lo sumo 50, con las tres bases de su versión vigente. El destino lo deriva
// la pantalla. Montos como cadenas NUMERIC exactas (`::text`).
import { consultar, type TxConsulta } from "../compras/errores";

/** Tope de filas del historial. */
export const TOPE_HISTORIAL = 50;

export interface CompraHistorialProveedor {
  periodo: string;
  serie: string;
  numero: string;
  biDg: string;
  biDgng: string;
  biDng: string;
  excluida: boolean;
}

const SQL_HISTORIAL = `select c.periodo, c.serie, c.numero, v.bi_dg::text as bi_dg, v.bi_dgng::text as bi_dgng,
    v.bi_dng::text as bi_dng, v.excluida
  from compra c cross join lateral (select * from compra_version x where x.tenant_id = c.tenant_id and x.compra_id = c.id
    and x.n = c.version_vigente offset 0) v
  where c.cliente_id = $1 and c.doc_tipo = $3 and c.doc_numero = $4 and c.descartada_en is null
    and c.periodo < $2::char(6) and c.periodo >= to_char(to_date($2::text, 'YYYYMM') - interval '6 months', 'YYYYMM')
  order by c.periodo desc, c.fecha desc, c.serie collate "C", lpad(c.numero, 20, '0') collate "C", c.id
  limit $5`;

/** Las compras del proveedor (`docTipo`, `docNumero`) del cliente en los 6 periodos anteriores a `periodo`, a lo sumo 50. */
export async function leerHistorialProveedor(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  proveedor: { docTipo: string; docNumero: string },
): Promise<CompraHistorialProveedor[]> {
  const r = await consultar(tx, SQL_HISTORIAL, [
    clienteId,
    periodo,
    proveedor.docTipo,
    proveedor.docNumero,
    TOPE_HISTORIAL,
  ]);
  return r.rows.map((f) => ({
    periodo: f.periodo,
    serie: f.serie,
    numero: f.numero,
    biDg: f.bi_dg,
    biDgng: f.bi_dgng,
    biDng: f.bi_dng,
    excluida: f.excluida,
  }));
}
