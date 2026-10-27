import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { clienteVisible, type Alcance, type ContappDb } from "@contapp/db";
import { sesionDe, type PeticionAuth } from "../../auth/guards/decoradores.js";
import { DB } from "../../auth/inyeccion.js";
import { AccesoError } from "../errores.js";
import type { PeticionAcceso } from "./decoradores.js";

/** UUID canónico (8-4-4-4-12 hex). Cualquier otra cosa es 404 sin tocar la BD. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Alcance por cliente (D5, CA-5). Solo actúa en rutas con `:clienteId`; va tras `PermisoGuard`, así el
 * 403 sale antes de mirar el cliente. Inexistente, de otro estudio o no asignado dan el mismo 404
 * `no_encontrado` (una sola consulta, `clienteVisible`), en un `withTenant` propio.
 */
@Injectable()
export class ClienteScopeGuard implements CanActivate {
  constructor(
    // Se recibe por simetría con `PermisoGuard` (la ruta se reconoce por `req.params`).
    @Inject(Reflector) readonly reflector: Reflector,
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PeticionAuth & PeticionAcceso>();
    const clienteId = req.params?.clienteId;
    if (clienteId === undefined) return true;

    const acceso = req.acceso;
    const sesion = sesionDe(req);
    if (
      acceso === undefined ||
      sesion === null ||
      sesion.tenantActivo === null
    ) {
      throw new AccesoError("permiso_denegado");
    }
    if (!UUID.test(clienteId)) throw new AccesoError("no_encontrado");

    // Un alcance distinto de 'global' se trata como asignado (falla cerrado).
    const alcance: Alcance =
      acceso.alcance === "global"
        ? { tipo: "global" }
        : { tipo: "asignado", usuarioId: acceso.usuarioId };
    const visible = await this.db.withTenant(
      { tenantId: sesion.tenantActivo, userId: sesion.usuarioId },
      (tx) => clienteVisible(tx, clienteId, alcance),
    );
    if (visible !== true) throw new AccesoError("no_encontrado");
    return true;
  }
}
