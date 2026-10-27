import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { miembroActual, type ContappDb } from "@contapp/db";
import {
  alcanceDe,
  PERMISOS,
  PERMISOS_POR_ROL,
  type Permiso as TipoPermiso,
  type Rol,
} from "@contapp/shared";
import { AuthError } from "../../auth/errores.js";
import {
  marcada,
  META_PUBLICO,
  META_SESION_OPCIONAL,
  META_SIN_ESTUDIO,
  sesionDe,
  type PeticionAuth,
} from "../../auth/guards/decoradores.js";
import { DB } from "../../auth/inyeccion.js";
import { AccesoError } from "../errores.js";
import {
  fijarAcceso,
  META_PERMISO,
  META_SOLO_ESTUDIO,
  type PeticionAcceso,
} from "./decoradores.js";

const DECLARACIONES_SIN_PERMISO = [
  META_SOLO_ESTUDIO,
  META_PUBLICO,
  META_SIN_ESTUDIO,
  META_SESION_OPCIONAL,
] as const;

const esPermiso = (v: unknown): v is TipoPermiso =>
  typeof v === "string" && (PERMISOS as readonly string[]).includes(v);

/**
 * Denegación por defecto (D4) y permiso por rol (D2, D3). Va tras `CsrfGuard`. Con `@Permiso(p)` lee
 * el rol de la membresía ACTIVA en un `withTenant` propio (nunca anidado; sin caché: CA-6), fija
 * `req.acceso` y exige `p`. Las demás declaraciones pasan sin consultar la BD (sus guards de 004 ya
 * exigieron lo suyo). Sin declaración: 403 `permiso_denegado`.
 */
@Injectable()
export class PermisoGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const declarado = this.reflector.getAllAndOverride<unknown>(META_PERMISO, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // `@Permiso` manda sobre cualquier otra marca (falla cerrado si alguien combina familias).
    if (declarado === undefined) {
      for (const meta of DECLARACIONES_SIN_PERMISO) {
        if (marcada(this.reflector, ctx, meta)) return true;
      }
      throw new AccesoError("permiso_denegado");
    }
    if (!esPermiso(declarado)) throw new AccesoError("permiso_denegado");

    const req = ctx.switchToHttp().getRequest<PeticionAuth & PeticionAcceso>();
    const sesion = sesionDe(req);
    if (sesion === null) throw new AuthError("sesion_invalida");
    if (sesion.tenantActivo === null || sesion.estudioRevocado) {
      throw new AccesoError("estudio_requerido");
    }

    const miembro = await this.db.withTenant(
      { tenantId: sesion.tenantActivo, userId: sesion.usuarioId },
      (tx) => miembroActual(tx, sesion.usuarioId),
    );
    if (miembro === null || miembro.usuarioId !== sesion.usuarioId) {
      throw new AccesoError("estudio_requerido");
    }
    const rol = miembro.rol as Rol;
    const permisos = PERMISOS_POR_ROL[rol] as
      ReadonlySet<TipoPermiso> | undefined;
    if (permisos === undefined || !permisos.has(declarado)) {
      throw new AccesoError("permiso_denegado");
    }
    fijarAcceso(req, {
      usuarioId: sesion.usuarioId,
      rol,
      permisos,
      alcance: alcanceDe(rol),
    });
    return true;
  }
}
