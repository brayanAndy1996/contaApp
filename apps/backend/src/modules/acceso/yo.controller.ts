import { Controller, Get, Inject } from "@nestjs/common";
import { miembroActual, type ContappDb } from "@contapp/db";
import {
  alcanceDe,
  PERMISOS,
  tienePermiso,
  type Permiso,
  type Rol,
} from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { DB } from "../auth/inyeccion.js";
import { AccesoError } from "./errores.js";
import { SoloEstudio } from "./guards/decoradores.js";

export interface AccesoYo {
  rol: Rol;
  permisos: Permiso[];
  alcance: "global" | "asignado";
}

/** `GET /acceso/yo`: rol, permisos y alcance de la membresía activa, leídos en cada petición (D3, CA-6). */
@Controller("acceso")
export class YoController {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  @Get("yo")
  @SoloEstudio()
  async yo(@Sesion() s: SesionResuelta): Promise<AccesoYo> {
    const tenantId = s.tenantActivo as string;
    const m = await this.db.withTenant(
      { tenantId, userId: s.usuarioId },
      (tx) => miembroActual(tx, s.usuarioId),
    );
    if (m === null) throw new AccesoError("estudio_requerido");
    const rol = m.rol as Rol;
    return {
      rol,
      permisos: PERMISOS.filter((p) => tienePermiso(rol, p)),
      alcance: alcanceDe(rol),
    };
  }
}
