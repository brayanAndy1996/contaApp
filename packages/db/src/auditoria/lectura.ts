// Lectura de la auditoría (spec 017, P-2, D-6): la página de `GET /auditoria`. Une `auditoria` (RLS por estudio, solo SELECT para el
// backend) con los descifrados de 003, que el backend lee únicamente por `auditoria_descifrado_listar` (sin SELECT sobre su
// tabla). Todo con la `tx` de withTenant; solo SQL estático y parametrizado.
import { consultar, type TxConsulta } from "../acceso/errores";

export type ActorTipoAuditoria = "usuario" | "trabajo" | "sistema";

export interface FilaAuditoria {
  id: string;
  ocurridaEn: Date;
  accion: string;
  actorTipo: ActorTipoAuditoria;
  usuarioId: string | null;
  trabajoId: string | null;
  clienteId: string | null;
  entidad: string;
  entidadId: string | null;
  datos: Record<string, unknown>;
}

export interface OpcionesAuditoria {
  /** Posición (ocurridaEn, id) de la última fila de la página anterior. */
  antes?: { en: Date; id: string };
  /** Se recorta a 1..50 (CA-12). */
  limite?: number;
}

export const MAX_PAGINA_AUDITORIA = 50;

// Los descifrados no guardan quién los pidió: actor `sistema`. `entidad` = su tabla de origen y `entidad_id` = su `id`.
const SQL_PAGINA = `select id, ocurrida_en, accion, actor_tipo, usuario_id, trabajo_id, cliente_id, entidad, entidad_id, datos
  from (
    select a.id, a.ocurrida_en, a.accion, a.actor_tipo, a.usuario_id, a.trabajo_id, a.cliente_id, a.entidad, a.entidad_id, a.datos
      from auditoria a
     where $1::timestamptz is null or a.ocurrida_en < $1::timestamptz
        or (a.ocurrida_en = $1::timestamptz and a.id < $2::uuid)
    union all
    select d.id, d.created_at, 'credencial.descifrada', 'sistema', null::uuid, null::uuid, d.cliente_id, 'auditoria_descifrado', d.id,
           jsonb_strip_nulls(jsonb_build_object('tipo', d.tipo, 'motivo', d.motivo, 'resultado', d.resultado))
      from auditoria_descifrado_listar($1::timestamptz, $2::uuid, $3::int) d
  ) u
 order by ocurrida_en desc, id desc
 limit $3::int`;

const limiteDe = (n: number | undefined): number => {
  if (n === undefined || !Number.isFinite(n)) return MAX_PAGINA_AUDITORIA;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGINA_AUDITORIA);
};

/** Página de auditoría del estudio, de la más nueva a la más vieja por (ocurridaEn, id); a lo sumo 50 filas. */
export async function listarAuditoria(tx: TxConsulta, o: OpcionesAuditoria = {}): Promise<FilaAuditoria[]> {
  const filas = await consultar(tx, SQL_PAGINA, [o.antes?.en ?? null, o.antes?.id ?? null, limiteDe(o.limite)]);
  return filas.map((f) => ({
    id: f.id,
    ocurridaEn: f.ocurrida_en,
    accion: f.accion,
    actorTipo: f.actor_tipo,
    usuarioId: f.usuario_id,
    trabajoId: f.trabajo_id,
    clienteId: f.cliente_id,
    entidad: f.entidad,
    entidadId: f.entidad_id,
    datos: f.datos,
  }));
}
