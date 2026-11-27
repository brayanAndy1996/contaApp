import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { miembroActual, type ContappDb, type SesionValida } from "@contapp/db";
import {
  alcanceDe,
  PERMISOS,
  PERMISOS_POR_ROL,
  type Permiso as TipoPermiso,
  type Rol,
} from "@contapp/shared";
import type { AuthService } from "../../auth/auth.service.js";
import { AuthError } from "../../auth/errores.js";
import {
  marcada,
  META_PERMITIR_SIN_FACTOR,
  META_PUBLICO,
  META_SESION_OPCIONAL,
  META_SIN_ESTUDIO,
  sesionDe,
  type PeticionAuth,
} from "../../auth/guards/decoradores.js";
import { DB } from "../../auth/inyeccion.js";
import { rolExigeFactor } from "../../auth/totp/exigencia.js";
import { AccesoError } from "../errores.js";
import {
  fijarAcceso,
  META_PERMISO,
  META_SOLO_ESTUDIO,
  META_SOLO_PLATAFORMA,
  type PeticionAcceso,
} from "./decoradores.js";

const esPermiso = (v: unknown): v is TipoPermiso =>
  typeof v === "string" && (PERMISOS as readonly string[]).includes(v);

/**
 * Denegación por defecto (D4) y permiso por rol (D2, D3). Va tras `CsrfGuard`. Con `@Permiso(p)` lee
 * el rol de la membresía ACTIVA en un `withTenant` propio (nunca anidado; sin caché: CA-6), fija
 * `req.acceso` y exige `p`. Las demás declaraciones pasan sin consultar la BD (sus guards de 004 ya
 * exigieron lo suyo). Sin declaración: 403 `permiso_denegado`.
 *
 * 029 (CA-4, U1–U2, D2): sin el segundo factor verificado en la sesión, 403 `segundo_factor_requerido` en toda ruta `@SoloPlataforma` y
 * en las de estudio (`@Permiso`, `@SoloEstudio`) cuyo rol lo exige (`factorExigido` de shared). El factor viene de la validación de
 * sesión; el rol, del mismo `miembroActual` de `@Permiso`. Una sesión `verificado` no hace ninguna consulta extra; solo una sin factor
 * en una ruta `@SoloEstudio` lee su rol. En las rutas `@SinEstudio`/`@SesionOpcional` con sesión sin factor verificado, si la cuenta lo
 * exige (`AuthService.factorExigido`, la regla de `GET /auth/sesion`) solo pasan las de la lista cerrada (`@PermitirSinFactor`); sin el
 * servicio, falla cerrado.
 */
@Injectable()
export class PermisoGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    private readonly exigencia?: Pick<AuthService, "factorExigido">,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const declarado = this.reflector.getAllAndOverride<unknown>(META_PERMISO, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // 006 (D5): `@SoloPlataforma` solo vale junto a `@SinEstudio` y sin ninguna otra declaración; cualquier otra
    // combinación falla cerrada sin consultar la BD. El alta en `admin_plataforma` la revalidan las funciones SQL.
    if (marcada(this.reflector, ctx, META_SOLO_PLATAFORMA)) {
      const otras = [
        META_SOLO_ESTUDIO,
        META_PUBLICO,
        META_SESION_OPCIONAL,
      ].some((meta) => marcada(this.reflector, ctx, meta));
      if (
        declarado !== undefined ||
        otras ||
        !marcada(this.reflector, ctx, META_SIN_ESTUDIO)
      ) {
        throw new AccesoError("permiso_denegado");
      }
      // 029 (U1): el super-admin siempre exige el factor; sin consulta (el alta la revalidan las funciones SQL).
      const sesion = sesionDe(ctx.switchToHttp().getRequest<PeticionAuth>());
      if (sesion === null) throw new AuthError("sesion_invalida");
      if (!verificada(sesion)) throw new AuthError("segundo_factor_requerido");
      return true;
    }
    // `@Permiso` manda sobre cualquier otra marca (falla cerrado si alguien combina familias).
    if (declarado === undefined) {
      if (marcada(this.reflector, ctx, META_SOLO_ESTUDIO)) {
        return this.soloEstudio(ctx);
      }
      if (marcada(this.reflector, ctx, META_PUBLICO)) return true;
      if (marcada(this.reflector, ctx, META_SIN_ESTUDIO) || marcada(this.reflector, ctx, META_SESION_OPCIONAL)) {
        return this.sinEstudio(ctx);
      }
      throw new AccesoError("permiso_denegado");
    }
    if (!esPermiso(declarado)) throw new AccesoError("permiso_denegado");

    const req = ctx.switchToHttp().getRequest<PeticionAuth & PeticionAcceso>();
    const { sesion, rol, permisos } = await this.rolActivo(req);
    // 029: la exigencia va antes que el permiso (un rol que lo exige no sondea permisos sin el factor).
    exigirFactor(sesion, rol);
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

  /**
   * `@SoloEstudio` (sin permiso): con la sesión verificada pasa sin consultar la BD, como antes de 029. Sin factor lee el rol de la
   * membresía activa y aplica la exigencia (U1–U2).
   */
  private async soloEstudio(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PeticionAuth & PeticionAcceso>();
    const sesion = sesionDe(req);
    if (sesion === null) throw new AuthError("sesion_invalida");
    if (verificada(sesion)) return true;
    const { rol } = await this.rolActivo(req);
    exigirFactor(sesion, rol);
    return true;
  }

  /**
   * `@SinEstudio`/`@SesionOpcional` (029, CA-4, U1–U3): sin sesión (opcional) o con la sesión verificada pasa sin consultar; en la lista
   * cerrada (`@PermitirSinFactor`) también. Si no, 403 `segundo_factor_requerido` cuando la cuenta exige el factor.
   */
  private async sinEstudio(ctx: ExecutionContext): Promise<boolean> {
    const sesion = sesionDe(ctx.switchToHttp().getRequest<PeticionAuth>());
    if (sesion === null || verificada(sesion)) return true;
    if (marcada(this.reflector, ctx, META_PERMITIR_SIN_FACTOR)) return true;
    if (this.exigencia === undefined || (await this.exigencia.factorExigido(sesion))) {
      throw new AuthError("segundo_factor_requerido");
    }
    return true;
  }

  /** Rol de la membresía ACTIVA en un `withTenant` propio (nunca anidado; sin caché: CA-6). */
  private async rolActivo(req: PeticionAuth): Promise<{
    sesion: SesionValida;
    rol: Rol;
    permisos: ReadonlySet<TipoPermiso> | undefined;
  }> {
    const sesion = sesionDe(req);
    if (sesion === null) throw new AuthError("sesion_invalida");
    if (sesion.tenantActivo === null || sesion.estudioRevocado) {
      throw new AccesoError("estudio_requerido");
    }
    const tenantId = sesion.tenantActivo;
    const miembro = await this.db.withTenant(
      { tenantId, userId: sesion.usuarioId },
      (tx) => miembroActual(tx, sesion.usuarioId),
    );
    if (miembro === null || miembro.usuarioId !== sesion.usuarioId) {
      throw new AccesoError("estudio_requerido");
    }
    const rol = miembro.rol as Rol;
    const permisos = PERMISOS_POR_ROL[rol] as
      ReadonlySet<TipoPermiso> | undefined;
    return { sesion, rol, permisos };
  }
}

/** Falla cerrado: solo `verificado` cuenta como segundo factor (un valor ausente o desconocido, no). */
function verificada(sesion: Pick<SesionValida, "factor">): boolean {
  return sesion.factor === "verificado";
}

/** 403 `segundo_factor_requerido` si el rol de la membresía activa lo exige y la sesión no lo verificó (U1–U2). */
function exigirFactor(sesion: Pick<SesionValida, "factor">, rol: Rol): void {
  if (!verificada(sesion) && rolExigeFactor(rol)) throw new AuthError("segundo_factor_requerido");
}
