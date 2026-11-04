// Cupo del plan (spec 006, D4, D6, D7). Todo con la `tx` de withTenant del llamador: la RLS limita al estudio del
// contexto y el filtro por `tenant_id` es defensa en profundidad. El backend no lee precios (grants por columna):
// estas consultas solo tocan columnas permitidas de `plan`.
//
// Orden de bloqueo (plan.md, Decisiones): (1) membresías que la acción toca -> (2) último Dueño -> (2') bloquearCupo
// -> (3) cliente -> (4) asignacion/invitacion. Es un único bloqueo advisory por estudio para usuarios y RUCs, el mismo
// que toma auth.cupo_usuarios_aceptar; dura hasta el commit o rollback de la transacción.
import { consultar, type TxConsulta } from "./errores";

export interface LimitesPlan {
  maxRucs: number;
  /** null = sin límite de usuarios. */
  maxUsuarios: number | null;
  maxRucsExtra: number;
  rucsExtraContratados: number;
}

export interface ConteoUsuarios {
  /** Membresías activas (desactivada_en NULL); el Dueño cuenta. */
  activos: number;
  /** Invitaciones vigentes: sin aceptar, sin revocar y sin vencer (D7). */
  pendientes: number;
}

// `$1::uuid::text`: la clave del bloqueo usa siempre la forma canónica del UUID (minúsculas), igual que la función SQL.
const SQL_BLOQUEAR =
  "select pg_advisory_xact_lock(hashtextextended('plan.cupo:' || $1::uuid::text, 0))";

const SQL_LIMITES = `select p.max_rucs, p.max_usuarios, p.max_rucs_extra, s.rucs_extra_contratados
  from suscripcion s join plan p on p.id = s.plan_id
 where s.tenant_id = $1::uuid`;

const SQL_USUARIOS = `select
  (select count(*) from membresia m where m.tenant_id = $1::uuid and m.desactivada_en is null)::int as activos,
  (select count(*) from invitacion i
    where i.tenant_id = $1::uuid and i.aceptada_en is null and i.revocada_en is null and i.vence_en > now())::int
    as pendientes`;

// Solo RUCs activos (007a D2): los archivados no consumen cupo.
const SQL_RUCS = "select count(*)::int as n from cliente where tenant_id = $1::uuid and archivado_at is null";

/** Toma el bloqueo de cupo del estudio hasta el fin de la transacción. Llamarlo antes de contar. */
export async function bloquearCupo(tx: TxConsulta, tenantId: string): Promise<void> {
  await consultar(tx, SQL_BLOQUEAR, [tenantId]);
}

/** Límites vigentes (plan + suscripción, leídos en cada llamada: CA-2). null = estudio sin suscripción. */
export async function leerLimites(tx: TxConsulta, tenantId: string): Promise<LimitesPlan | null> {
  const f = (await consultar(tx, SQL_LIMITES, [tenantId]))[0];
  return f === undefined
    ? null
    : {
        maxRucs: Number(f.max_rucs),
        maxUsuarios: f.max_usuarios === null ? null : Number(f.max_usuarios),
        maxRucsExtra: Number(f.max_rucs_extra),
        rucsExtraContratados: Number(f.rucs_extra_contratados),
      };
}

export async function contarUsuarios(tx: TxConsulta, tenantId: string): Promise<ConteoUsuarios> {
  const f = (await consultar(tx, SQL_USUARIOS, [tenantId]))[0]!;
  return { activos: Number(f.activos), pendientes: Number(f.pendientes) };
}

export async function contarRucs(tx: TxConsulta, tenantId: string): Promise<number> {
  return Number((await consultar(tx, SQL_RUCS, [tenantId]))[0]!.n);
}
