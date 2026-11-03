// Uso del plan del estudio (spec 006, GET /plan/uso). Sin precios (D8; el backend no tiene SELECT sobre precio_*).
// El backend arma `UsoPlanDto` con estos datos y `limiteEfectivoRucs` de @contapp/shared.
import { consultar, type TxConsulta } from "./errores";
import type { ConteoUsuarios, LimitesPlan } from "./cupo";

export interface UsoDelEstudio extends LimitesPlan {
  plan: { codigo: string; nombre: string };
  estado: "prueba" | "activa";
  pruebaVenceEn: Date | null;
  rucsUsados: number;
  usuarios: ConteoUsuarios;
}

// Una sola sentencia (una instantánea): suscripción, columnas permitidas del plan y conteos del estudio.
const SQL_USO = `select p.codigo, p.nombre, s.estado, s.prueba_vence_en,
       p.max_rucs, p.max_usuarios, p.max_rucs_extra, s.rucs_extra_contratados,
       (select count(*) from cliente c where c.tenant_id = s.tenant_id and c.archivado_at is null)::int as rucs_usados,
       (select count(*) from membresia m where m.tenant_id = s.tenant_id and m.desactivada_en is null)::int as activos,
       (select count(*) from invitacion i
         where i.tenant_id = s.tenant_id and i.aceptada_en is null and i.revocada_en is null and i.vence_en > now())::int
         as pendientes
  from suscripcion s join plan p on p.id = s.plan_id
 where s.tenant_id = $1::uuid`;

/** Uso y límites del estudio del contexto; null = estudio sin suscripción (409 sin_plan). */
export async function usoDelEstudio(tx: TxConsulta, tenantId: string): Promise<UsoDelEstudio | null> {
  const f = (await consultar(tx, SQL_USO, [tenantId]))[0];
  if (f === undefined) return null;
  return {
    plan: { codigo: f.codigo, nombre: f.nombre },
    estado: f.estado,
    pruebaVenceEn: f.prueba_vence_en ?? null,
    maxRucs: Number(f.max_rucs),
    maxUsuarios: f.max_usuarios === null ? null : Number(f.max_usuarios),
    maxRucsExtra: Number(f.max_rucs_extra),
    rucsExtraContratados: Number(f.rucs_extra_contratados),
    rucsUsados: Number(f.rucs_usados),
    usuarios: { activos: Number(f.activos), pendientes: Number(f.pendientes) },
  };
}
