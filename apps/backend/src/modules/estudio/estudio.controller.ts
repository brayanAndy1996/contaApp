import { Controller, Get, Inject } from "@nestjs/common";
import { schema, type ContappDb } from "@contapp/db";
import type { Estudio, SesionResuelta } from "../auth/auth.service.js";
import { AuthError } from "../auth/errores.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { DB } from "../auth/inyeccion.js";

/**
 * Ruta de negocio mínima (CA-9): devuelve el estudio activo de la sesión. Los guards globales ya
 * exigieron sesión, estudio con membresía vigente y `X-Estudio` igual; la consulta va en `withTenant`
 * (RLS) y se abre después de que `SesionGuard` terminó (nunca anidada).
 */
@Controller("estudio")
export class EstudioController {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  @Get("actual")
  async actual(@Sesion() sesion: SesionResuelta): Promise<Estudio> {
    const tenantId = sesion.tenantActivo as string;
    const filas = await this.db.withTenant({ tenantId, userId: sesion.usuarioId }, (tx) =>
      tx.orm.select({ id: schema.tenant.id, nombre: schema.tenant.nombre }).from(schema.tenant),
    );
    const estudio = filas.find((f) => f.id === tenantId);
    if (estudio === undefined) throw new AuthError("estudio_requerido");
    return { id: estudio.id, nombre: estudio.nombre };
  }
}
