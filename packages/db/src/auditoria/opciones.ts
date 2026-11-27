// Opciones del selector de la consulta de auditoría (spec 031, D-6): miembros del estudio (activos e inactivos; los eliminados ya no
// tienen membresía) y clientes visibles con el alcance de quien consulta, buscados por prefijo de RUC o por razón social (ILIKE, con
// archivados). Todo con la `tx` de withTenant (la RLS limita al estudio). Texto SQL fijo para cada alcance: `q` y `clienteId` viajan
// como parámetros, con los comodines de LIKE (`\`, `%`, `_`) escapados en el valor. El alcance pasa por `filtroAlcance` (005 D5); lo
// que no es exactamente `{ tipo: "global" }` se trata como asignado (falla cerrado).
import { sql } from "drizzle-orm";
import { filtroAlcance, renderizar, type Alcance } from "../acceso/alcance";
import { consultar, type TxConsulta } from "../acceso/errores";
import { cliente } from "../schema/clientes";

export const MAX_CLIENTES_OPCIONES = 20;

export interface MiembroOpcion {
  id: string;
  nombre: string;
  activo: boolean;
}

export interface ClienteOpcion {
  id: string;
  ruc: string;
  razonSocial: string;
  archivado: boolean;
}

export interface SelectorAuditoria {
  miembros: MiembroOpcion[];
  clientes: ClienteOpcion[];
}

export interface ConsultaSelectorAuditoria {
  /** Texto buscado (1–60, ya validado en `shared`); null = sin búsqueda. */
  q: string | null;
  /** Cliente a incluir si es visible (para pintarlo al recargar la pantalla). */
  clienteId: string | null;
  alcance: Alcance;
}

const SQL_MIEMBROS = `select m.usuario_id as id, u.nombre, m.desactivada_en is null as activo
  from membresia m join usuario u on u.id = m.usuario_id
 order by u.nombre, m.usuario_id`;

const escaparLike = (q: string): string => q.replace(/[\\%_]/g, "\\$&");

const alcanceSeguro = (a: unknown): Alcance => {
  if (typeof a === "object" && a !== null && (a as { tipo?: unknown }).tipo === "global") return { tipo: "global" };
  const u = typeof a === "object" && a !== null ? (a as { usuarioId?: unknown }).usuarioId : undefined;
  return { tipo: "asignado", usuarioId: typeof u === "string" ? u : (null as unknown as string) };
};

function consultaClientes(o: { prefijo: string | null; contiene: string | null; clienteId: string | null; alcance: Alcance }) {
  const columnas = sql`${cliente.id} as id, ${cliente.ruc} as ruc, ${cliente.razonSocial} as razon_social, ${cliente.archivadoAt} is not null as archivado`;
  return renderizar(sql`select id, ruc, razon_social, archivado from (
  (select ${columnas}
     from ${cliente}
    where ${o.prefijo}::text is not null
      and (${cliente.ruc} like ${o.prefijo}::text escape '\\' or ${cliente.razonSocial} ilike ${o.contiene}::text escape '\\')
      and ${filtroAlcance(cliente.id, o.alcance)}
    order by ${cliente.razonSocial}, ${cliente.id}
    limit ${sql.raw(String(MAX_CLIENTES_OPCIONES))})
  union
  (select ${columnas}
     from ${cliente}
    where ${cliente.id} = ${o.clienteId}::uuid
      and ${filtroAlcance(cliente.id, o.alcance)})
) x
order by razon_social, id`);
}

/** Miembros (todos, por nombre) y clientes visibles (máx. 20 por búsqueda, más `clienteId` si es visible), por razón social. */
export async function opcionesAuditoria(tx: TxConsulta, o: ConsultaSelectorAuditoria): Promise<SelectorAuditoria> {
  const alcance = alcanceSeguro(o?.alcance);
  const escapado = o.q === null || o.q === undefined ? null : escaparLike(o.q);
  const { texto, valores } = consultaClientes({
    prefijo: escapado === null ? null : `${escapado}%`,
    contiene: escapado === null ? null : `%${escapado}%`,
    clienteId: o.clienteId ?? null,
    alcance,
  });
  const miembros = await consultar(tx, SQL_MIEMBROS, []);
  const clientes = await consultar(tx, texto, valores);
  return {
    miembros: miembros.map((f) => ({ id: f.id, nombre: f.nombre, activo: f.activo })),
    clientes: clientes.map((f) => ({ id: f.id, ruc: f.ruc, razonSocial: f.razon_social, archivado: f.archivado })),
  };
}
