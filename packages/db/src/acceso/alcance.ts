// Filtro de alcance (D5): el ÚNICO filtro de visibilidad de clientes para 005 y las specs siguientes.
// global -> todos los clientes del estudio (la RLS ya limita al estudio); asignado -> solo los clientes con una
// asignación (responsable o colaborador) del usuario. El usuario viaja siempre como parámetro.
import { sql, type SQL } from "drizzle-orm";
import { PgDialect, type PgColumn } from "drizzle-orm/pg-core";
import { cliente } from "../schema/clientes";
import { consultar, type TxConsulta } from "./errores";

export type Alcance =
  { tipo: "global" } | { tipo: "asignado"; usuarioId: string };

/** Condición SQL para una columna con el id del cliente. Un alcance no global se trata como asignado (falla cerrado). */
export function filtroAlcance(
  columnaClienteId: PgColumn | SQL,
  a: Alcance,
): SQL {
  return a.tipo === "global"
    ? sql`true`
    : sql`exists (select 1 from asignacion asg where asg.cliente_id = ${columnaClienteId} and asg.usuario_id = ${(a as { usuarioId?: string }).usuarioId}::uuid)`;
}

const dialecto = new PgDialect();

/** Texto y parámetros de una consulta de drizzle (texto fijo; los valores van como $n). */
export function renderizar(q: SQL): { texto: string; valores: unknown[] } {
  const r = dialecto.sqlToQuery(q);
  return { texto: r.sql, valores: r.params };
}

/** ¿El cliente existe en el estudio del contexto y es visible con este alcance? Inexistente, ajeno y no asignado: false. */
export async function clienteVisible(
  tx: TxConsulta,
  clienteId: string,
  a: Alcance,
): Promise<boolean> {
  const { texto, valores } = renderizar(
    sql`select exists (select 1 from cliente where ${cliente.id} = ${clienteId}::uuid and ${filtroAlcance(cliente.id, a)}) as visible`,
  );
  const filas = await consultar(tx, texto, valores);
  return filas[0]?.visible === true;
}
