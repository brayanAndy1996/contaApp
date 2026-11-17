// Lecturas de reglas aprendidas (spec 021, CA-5, CA-7, P-4). Solo SQL estático y parametrizado en la `tx` de withTenant: la RLS
// deja ver solo el estudio y cada consulta filtra además por cliente (nunca por RUC del proveedor). Sin eliminadas.
import { consultar, type Fila, type TxConsulta } from "../compras/errores";
import type { DestinoRegla, ReglaFila } from "./tipos";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuidRegla = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Documento del proveedor normalizado como R-NEW (sin espacios y en mayúsculas), en SQL. */
export const DOC_NUMERO_NORMALIZADO = (columna: string) =>
  `upper(regexp_replace(${columna}, '[[:space:]]', '', 'g'))`;

// Razón social: la de la compra más reciente del proveedor en ese cliente (la más nueva con razón social).
const SQL_VISTA = `select r.id, r.cliente_id, r.doc_tipo, r.doc_numero, r.destino, r.activa, r.version,
    r.periodo_aprendido::text as periodo_aprendido, r.creada_por, r.creada_en, r.actualizada_en,
    (select c.razon_social from compra c
      where c.cliente_id = r.cliente_id and btrim(c.doc_tipo) = r.doc_tipo
        and ${DOC_NUMERO_NORMALIZADO("c.doc_numero")} = r.doc_numero and c.razon_social is not null
      order by c.periodo desc, c.fecha desc, c.creada_en desc, c.id desc limit 1) as razon_social,
    (select count(*)::int from regla_aplicacion a where a.regla_id = r.id) as aplicada,
    (select count(*)::int from regla_aceptacion a where a.regla_id = r.id) as aceptada
  from regla_aprendida r
  where r.cliente_id = $1 and r.eliminada_en is null and ($2::uuid is null or r.id = $2::uuid)
  order by r.creada_en, r.id`;

const aReglaFila = (f: Fila): ReglaFila => ({
  id: f.id as string,
  clienteId: f.cliente_id as string,
  docTipo: f.doc_tipo as string,
  docNumero: f.doc_numero as string,
  destino: f.destino as DestinoRegla,
  activa: f.activa as boolean,
  version: f.version as number,
  periodoAprendido: f.periodo_aprendido as string,
  creadaPor: f.creada_por as string,
  creadaEn: f.creada_en as Date,
  actualizadaEn: f.actualizada_en as Date,
  razonSocial: (f.razon_social as string | null) ?? null,
  aplicada: f.aplicada as number,
  aceptada: f.aceptada as number,
});

/** Reglas vivas del cliente (activas e inactivas), en orden de creación. Un cliente ajeno o inexistente devuelve `[]`. */
export async function listarReglas(tx: TxConsulta, clienteId: string): Promise<ReglaFila[]> {
  if (!esUuidRegla(clienteId)) return [];
  const r = await consultar(tx, SQL_VISTA, [clienteId, null]);
  return r.rows.map(aReglaFila);
}

/** Una regla viva del cliente, o `null` si no existe, es de otro cliente o estudio, o está eliminada. */
export async function leerRegla(
  tx: TxConsulta,
  clienteId: string,
  reglaId: string,
): Promise<ReglaFila | null> {
  if (!esUuidRegla(clienteId) || !esUuidRegla(reglaId)) return null;
  const r = await consultar(tx, SQL_VISTA, [clienteId, reglaId]);
  const f = r.rows[0];
  return f ? aReglaFila(f) : null;
}
