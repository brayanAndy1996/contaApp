// Indicador de mensajes nuevos por cliente (spec 024, D-9, D-12; CA-8). «Nuevo» = pendiente: sin atender y no histórico, leído o
// no en SUNAT. Una sola consulta para todos los clientes pedidos, sobre el índice parcial
// buzon_mensaje_cliente_pendiente_idx (0059, con INCLUDE critico). Con la `tx` de withTenant: la RLS deja fuera a otros estudios.
import { consultar, type TxConsulta } from "./errores";

export interface IndicadorBuzon {
  nuevos: number;
  criticosNuevos: number;
}

// LATERAL por cliente (CA-9): con ~70 % de pendientes, `cliente_id = any($1)` sobre toda la tabla lleva al planificador a un barrido
// secuencial; el recorrido por cliente obliga a un Index Only Scan del parcial (tenant, cliente) para cada uno. Sigue siendo UNA
// sentencia para todo el listado.
const SQL_INDICADOR = `select x.id as cliente_id, k.nuevos, k.criticos
  from unnest($1::uuid[]) as x(id)
  cross join lateral (
    select count(*)::integer as nuevos, (count(*) filter (where m.critico))::integer as criticos
      from buzon_mensaje m
     where m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
       and m.cliente_id = x.id
       and m.atendido_en is null
       and not m.historico) k
 where k.nuevos > 0`;

/** Nuevos y críticos nuevos por cliente; los clientes sin nuevos no aparecen en el mapa. Lista vacía: mapa vacío, sin consultar. */
export async function indicadorBuzon(
  tx: TxConsulta,
  clienteIds: string[],
): Promise<Map<string, IndicadorBuzon>> {
  const mapa = new Map<string, IndicadorBuzon>();
  if (clienteIds.length === 0) return mapa;
  const r = await consultar(tx, SQL_INDICADOR, [clienteIds]);
  for (const f of r.rows)
    mapa.set(String(f.cliente_id), {
      nuevos: Number(f.nuevos),
      criticosNuevos: Number(f.criticos),
    });
  return mapa;
}
