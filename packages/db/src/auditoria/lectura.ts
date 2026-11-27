// Lectura de la auditoría (spec 017, P-2, D-6; spec 031, D-1, D-3, D-4): la página de `GET /auditoria`. Une `auditoria` (RLS por
// estudio, solo SELECT para el backend) con los descifrados de 003, que el backend lee únicamente por `auditoria_descifrado_listar`
// (sin SELECT sobre su tabla). Todo con la `tx` de withTenant.
//
// 031: el texto SQL es FIJO para cada alcance (uno global y uno asignado) y todo valor viaja como `$n`; un filtro ausente es `null`
// (D-1, CA-7). Cada rama lleva sus filtros, su ORDER BY y su LIMIT antes de la unión. El alcance asignado recorre por LATERAL los
// clientes asignados (índice `auditoria_cliente_idx`) y conserva el predicado de `filtroAlcance` con `cliente_id is not null` (P-5);
// la función de descifrados recibe `p_global = false` y el usuario del alcance. Lo que no es exactamente `{ tipo: "global" }` se trata
// como asignado (falla cerrado). La rama de descifrados recibe LIMIT 0 con `usuarioId` (no guardan actor, D-4) o cuando `acciones` no
// incluye `credencial.descifrada`.
import { consultar, type TxConsulta } from "../acceso/errores";
import type { Alcance } from "../acceso/alcance";

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

/** Filtros de la consulta (031, D-1). Cada uno `null` = sin filtro; `desde` inclusivo y `hastaExclusivo` exclusivo. */
export interface FiltrosAuditoria {
  usuarioId: string | null;
  clienteId: string | null;
  acciones: readonly string[] | null;
  desde: Date | null;
  hastaExclusivo: Date | null;
}

export interface OpcionesAuditoria {
  /** Posición (ocurridaEn, id) de la última fila de la página anterior. */
  antes?: { en: Date; id: string };
  /** Se recorta a 1..50 (CA-12). */
  limite?: number;
  /** Alcance de quien consulta (030 `alcanceDe(acceso)`), nunca de la petición. Obligatorio (D-3). */
  alcance: Alcance;
  filtros?: FiltrosAuditoria;
}

export const MAX_PAGINA_AUDITORIA = 50;

const DESCIFRADA = "credencial.descifrada";

// Parámetros (iguales en los dos textos):
//   $1 antes · $2 antes_id · $3 límite · $4 usuario · $5 cliente · $6 acciones · $7 desde · $8 hasta (exclusivo)
//   $9 límite de descifrados · $10 p_global · $11 usuario del alcance · $12 acción única (con una sola acción va aquí y $6 es null:
//   deja usar `auditoria_accion_idx` en orden; `= any(...)` sobre la 2.ª columna no da orden en PG 16).
const COLUMNAS_A = "a.id, a.ocurrida_en, a.accion, a.actor_tipo, a.usuario_id, a.trabajo_id, a.cliente_id, a.entidad, a.entidad_id, a.datos";

const FILTROS_A = `($1::timestamptz is null or (a.ocurrida_en, a.id) < ($1::timestamptz, $2::uuid))
       and ($4::uuid is null or a.usuario_id = $4::uuid)
       and ($5::uuid is null or a.cliente_id = $5::uuid)
       and ($6::text[] is null or a.accion = any($6::text[]))
       and ($12::text is null or a.accion = $12::text)
       and ($7::timestamptz is null or a.ocurrida_en >= $7::timestamptz)
       and ($8::timestamptz is null or a.ocurrida_en < $8::timestamptz)`;

// El orden de cada rama coincide con el de los índices de 017 y 031 (DESC NULLS LAST).
const ORDEN_A = "order by a.ocurrida_en desc nulls last, a.id desc nulls last";

const RAMA_GLOBAL = `(select ${COLUMNAS_A}
      from auditoria a
     where ${FILTROS_A}
     ${ORDEN_A}
     limit $3::int)`;

const RAMA_ASIGNADO = `(select x.id, x.ocurrida_en, x.accion, x.actor_tipo, x.usuario_id, x.trabajo_id, x.cliente_id, x.entidad, x.entidad_id, x.datos
      from asignacion asg
     cross join lateral (
       select ${COLUMNAS_A}
         from auditoria a
        where a.cliente_id = asg.cliente_id
          and a.cliente_id is not null
          and exists (select 1 from asignacion asg2 where asg2.cliente_id = a.cliente_id and asg2.usuario_id = $11::uuid)
          and ${FILTROS_A}
        ${ORDEN_A}
        limit $3::int) x
     where asg.usuario_id = $11::uuid and ($5::uuid is null or asg.cliente_id = $5::uuid)
     order by x.ocurrida_en desc, x.id desc
     limit $3::int)`;

// Los descifrados no guardan quién los pidió: actor `sistema`. `entidad` = su tabla de origen y `entidad_id` = su `id`.
const RAMA_DESCIFRADOS = `select d.id, d.created_at, '${DESCIFRADA}', 'sistema', null::uuid, null::uuid, d.cliente_id, 'auditoria_descifrado', d.id,
           jsonb_strip_nulls(jsonb_build_object('tipo', d.tipo, 'motivo', d.motivo, 'resultado', d.resultado))
      from auditoria_descifrado_listar($1::timestamptz, $2::uuid, $9::int, $5::uuid, $7::timestamptz, $8::timestamptz, $10::boolean, $11::uuid) d`;

const pagina = (ramaAuditoria: string): string => `select id, ocurrida_en, accion, actor_tipo, usuario_id, trabajo_id, cliente_id, entidad, entidad_id, datos
  from (
    ${ramaAuditoria}
    union all
    ${RAMA_DESCIFRADOS}
  ) u
 order by ocurrida_en desc, id desc
 limit $3::int`;

const SQL_PAGINA_GLOBAL = pagina(RAMA_GLOBAL);
const SQL_PAGINA_ASIGNADO = pagina(RAMA_ASIGNADO);

const limiteDe = (n: number | undefined): number => {
  if (n === undefined || !Number.isFinite(n)) return MAX_PAGINA_AUDITORIA;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGINA_AUDITORIA);
};

/** Global solo si lo es exactamente; cualquier otra cosa es asignado con su usuario (o ninguno): falla cerrado. */
const esGlobal = (a: unknown): boolean =>
  typeof a === "object" && a !== null && (a as { tipo?: unknown }).tipo === "global";

const usuarioDelAlcance = (a: unknown): string | null => {
  const u = typeof a === "object" && a !== null ? (a as { usuarioId?: unknown }).usuarioId : undefined;
  return typeof u === "string" ? u : null;
};

/** Página de auditoría del estudio con filtros y alcance, de la más nueva a la más vieja por (ocurridaEn, id); a lo sumo 50 filas. */
export async function listarAuditoria(tx: TxConsulta, o: OpcionesAuditoria): Promise<FilaAuditoria[]> {
  const op: Partial<OpcionesAuditoria> = o ?? {};
  const f = op.filtros;
  const limite = limiteDe(op.limite);
  const usuarioId = f?.usuarioId ?? null;
  const acciones = f?.acciones ? [...f.acciones] : null;
  const sinDescifrados = usuarioId !== null || (acciones !== null && !acciones.includes(DESCIFRADA));
  const global = esGlobal(op.alcance);
  // Una sola acción viaja como igualdad ($12) y no como arreglo: con `= any` en la condición del índice PG 16 pierde el orden y ordena
  // todas las filas de esa acción.
  const unica = acciones !== null && acciones.length === 1 ? acciones[0]! : null;
  const filas = await consultar(tx, global ? SQL_PAGINA_GLOBAL : SQL_PAGINA_ASIGNADO, [
    op.antes?.en ?? null,
    op.antes?.id ?? null,
    limite,
    usuarioId,
    f?.clienteId ?? null,
    unica === null ? acciones : null,
    f?.desde ?? null,
    f?.hastaExclusivo ?? null,
    sinDescifrados ? 0 : limite,
    global,
    global ? null : usuarioDelAlcance(op.alcance),
    unica,
  ]);
  return filas.map((fila) => ({
    id: fila.id,
    ocurridaEn: fila.ocurrida_en,
    accion: fila.accion,
    actorTipo: fila.actor_tipo,
    usuarioId: fila.usuario_id,
    trabajoId: fila.trabajo_id,
    clienteId: fila.cliente_id,
    entidad: fila.entidad,
    entidadId: fila.entidad_id,
    datos: fila.datos,
  }));
}
