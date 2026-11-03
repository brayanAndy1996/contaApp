import { Inject, Injectable } from "@nestjs/common";
import { usoDelEstudio, type ContappDb } from "@contapp/db";
import { limiteEfectivoRucs, type UsoPlanDto } from "@contapp/shared";
import { DB } from "../auth/inyeccion.js";
import { PlanNoDisponibleError } from "./cupo/errores.js";

/** Uso del plan del estudio de la sesión (D8): sin precios ni identificadores. */
@Injectable()
export class PlanesService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async uso(tenantId: string, usuarioId: string): Promise<UsoPlanDto> {
    const u = await this.db.withTenant({ tenantId, userId: usuarioId }, (tx) =>
      usoDelEstudio(tx, tenantId),
    );
    if (u === null) throw new PlanNoDisponibleError();
    const limite = limiteEfectivoRucs(
      u.maxRucs,
      u.maxRucsExtra,
      u.rucsExtraContratados,
    );
    return {
      plan: u.plan,
      estado: u.estado,
      pruebaVenceEn: u.pruebaVenceEn === null ? null : new Date(u.pruebaVenceEn).toISOString(),
      rucs: {
        usados: u.rucsUsados,
        limite,
        libres: Math.max(0, limite - u.rucsUsados),
        extra: Math.min(u.rucsExtraContratados, u.maxRucsExtra),
      },
      usuarios: {
        usados: u.usuarios.activos,
        pendientes: u.usuarios.pendientes,
        limite: u.maxUsuarios,
      },
    };
  }
}
