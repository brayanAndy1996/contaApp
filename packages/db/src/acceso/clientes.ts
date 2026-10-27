// Lectura mínima de clientes (spec 005, D12/D20): 005 solo lee `cliente`. El listado se filtra con
// filtroAlcance (D5); la RLS limita al estudio del contexto.
import { sql } from "drizzle-orm";
import { cliente } from "../schema/clientes";
import { filtroAlcance, renderizar, type Alcance } from "./alcance";
import { consultar, type Fila, type TxConsulta } from "./errores";

export interface ClienteListado {
  id: string;
  ruc: string;
  razonSocial: string;
  responsable: { usuarioId: string; nombre: string } | null;
}

export interface ClienteLeido {
  id: string;
  ruc: string;
  razonSocial: string;
}

const SQL_LEER =
  "select id, ruc, razon_social from cliente where id = $1::uuid";

/** Clientes visibles con el alcance, por razón social, con su responsable (si tiene). */
export async function listarClientes(
  tx: TxConsulta,
  a: Alcance,
): Promise<ClienteListado[]> {
  const { texto, valores } = renderizar(
    sql`select ${cliente.id} as id, ${cliente.ruc} as ruc, ${cliente.razonSocial} as razon_social,
               r.usuario_id as responsable_id, u.nombre as responsable_nombre
          from cliente
          left join asignacion r on r.cliente_id = ${cliente.id} and r.tipo = ${"responsable"}
          left join usuario u on u.id = r.usuario_id
         where ${filtroAlcance(cliente.id, a)}
         order by ${cliente.razonSocial}, ${cliente.id}`,
  );
  const filas = await consultar(tx, texto, valores);
  return filas.map((f: Fila) => ({
    id: f.id,
    ruc: f.ruc,
    razonSocial: f.razon_social,
    responsable:
      f.responsable_id === null
        ? null
        : { usuarioId: f.responsable_id, nombre: f.responsable_nombre },
  }));
}

/** Un cliente del estudio del contexto (sin alcance: lo aplica ClienteScopeGuard), o null. */
export async function leerCliente(
  tx: TxConsulta,
  clienteId: string,
): Promise<ClienteLeido | null> {
  const filas = await consultar(tx, SQL_LEER, [clienteId]);
  const f = filas[0];
  return f === undefined
    ? null
    : { id: f.id, ruc: f.ruc, razonSocial: f.razon_social };
}
