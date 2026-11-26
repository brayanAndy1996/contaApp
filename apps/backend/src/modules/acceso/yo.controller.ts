import { Controller, Get, Inject } from "@nestjs/common";
import { leerRol, miembroActual, type ContappDb } from "@contapp/db";
import { PERMISOS, type Permiso, type Rol } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { DB } from "../auth/inyeccion.js";
import { efectivoDe } from "./efectivo.js";
import { AccesoError } from "./errores.js";
import { SoloEstudio } from "./guards/decoradores.js";

/** Rol propio asignado (030): solo id y nombre. */
export interface RolPropioRef {
  id: string;
  nombre: string;
}

export interface AccesoYo {
  /** Rol de sistema o `'propio'` (030). */
  rol: Rol | "propio";
  /** Permisos efectivos, en el orden del catálogo. */
  permisos: Permiso[];
  alcance: "global" | "asignado";
  /** Rol propio (030): `{id, nombre}`; null con un rol de sistema. */
  rolPropio: RolPropioRef | null;
}

/**
 * `GET /acceso/yo`: rol, permisos y alcance EFECTIVOS de la membresía activa (rol de sistema o propio, 030 D3), leídos en cada petición
 * (D3, CA-6); con un rol propio, además su id y nombre (el nombre editado sale en la siguiente petición).
 */
@Controller("acceso")
export class YoController {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  @Get("yo")
  @SoloEstudio()
  async yo(@Sesion() s: SesionResuelta): Promise<AccesoYo> {
    const tenantId = s.tenantActivo as string;
    const r = await this.db.withTenant(
      { tenantId, userId: s.usuarioId },
      async (tx) => {
        const m = await miembroActual(tx, s.usuarioId);
        const rol = m !== null && m.rol === "propio" && m.rolId !== null ? await leerRol(tx, m.rolId) : null;
        return { m, rol };
      },
    );
    const { m } = r;
    if (m === null) throw new AccesoError("estudio_requerido");
    const e = efectivoDe(m);
    if (e === null) throw new AccesoError("estudio_requerido");
    return {
      rol: m.rol as Rol | "propio",
      permisos: PERMISOS.filter((p) => e.permisos.has(p)),
      alcance: e.alcance,
      rolPropio: r.rol === null ? null : { id: r.rol.id, nombre: r.rol.nombre },
    };
  }
}
