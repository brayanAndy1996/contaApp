import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthError } from "../errores.js";
import { csrfValido } from "../sesion/csrf.js";
import {
  esMetodoSeguro,
  marcada,
  META_PUBLICO,
  META_SESION_OPCIONAL,
  sesionDe,
  type PeticionAuth,
} from "./decoradores.js";

/**
 * D6 / CA-7: toda petición que no es GET con sesión exige `X-CSRF-Token` igual al derivado del token
 * de sesión (comparación en tiempo constante). Si no, 403 `csrf_invalido`.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<PeticionAuth>();
    if (esMetodoSeguro(req.method) || marcada(this.reflector, ctx, META_PUBLICO)) return true;
    const sesion = sesionDe(req);
    if (sesion === null) {
      if (marcada(this.reflector, ctx, META_SESION_OPCIONAL)) return true;
      throw new AuthError("sesion_invalida");
    }
    if (!csrfValido(sesion.token, req.headers["x-csrf-token"])) throw new AuthError("csrf_invalido");
    return true;
  }
}
