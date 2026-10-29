import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthService } from "../auth.service.js";
import { AuthError } from "../errores.js";
import {
  fijarSesion,
  marcada,
  META_PUBLICO,
  META_SESION_OPCIONAL,
  META_SIN_RENOVAR,
  type PeticionAuth,
} from "./decoradores.js";

/**
 * Resuelve `{ userId, tenantId, sesionId }` desde la cookie con `withAuth`, ANTES de que el
 * controlador abra `withTenant` y nunca dentro (CA-11). Sin sesión válida: 401 `sesion_invalida`,
 * salvo en `@Publico()` (no se resuelve) y `@SesionOpcional()` (sigue sin sesión). En `@SinRenovarSesion()`
 * (008 D22) valida sin renovar `ultimo_uso`.
 */
@Injectable()
export class SesionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: Pick<AuthService, "resolverSesion">,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (marcada(this.reflector, ctx, META_PUBLICO)) return true;
    const req = ctx.switchToHttp().getRequest<PeticionAuth>();
    const cookie = req.headers.cookie;
    const valor = typeof cookie === "string" ? cookie : undefined;
    const sesion = marcada(this.reflector, ctx, META_SIN_RENOVAR)
      ? await this.auth.resolverSesion(valor, { renovar: false })
      : await this.auth.resolverSesion(valor);
    if (sesion !== null) {
      fijarSesion(req, sesion);
      return true;
    }
    if (marcada(this.reflector, ctx, META_SESION_OPCIONAL)) return true;
    throw new AuthError("sesion_invalida");
  }
}
