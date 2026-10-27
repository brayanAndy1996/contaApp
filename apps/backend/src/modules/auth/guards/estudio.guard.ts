import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthError } from "../errores.js";
import {
  marcada,
  META_PUBLICO,
  META_SESION_OPCIONAL,
  META_SIN_ESTUDIO,
  sesionDe,
  type PeticionAuth,
} from "./decoradores.js";

/**
 * D12 / CA-9: las rutas de negocio exigen estudio activo con membresía vigente (si no, 403
 * `estudio_requerido`) y `X-Estudio` igual al de la sesión (si falta o difiere, 409
 * `estudio_desfasado`). Va antes que CSRF para que una pestaña vieja reciba 409.
 */
@Injectable()
export class EstudioGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    for (const meta of [META_PUBLICO, META_SIN_ESTUDIO, META_SESION_OPCIONAL]) {
      if (marcada(this.reflector, ctx, meta)) return true;
    }
    const req = ctx.switchToHttp().getRequest<PeticionAuth>();
    const sesion = sesionDe(req);
    if (sesion === null) throw new AuthError("sesion_invalida");
    if (sesion.tenantActivo === null || sesion.estudioRevocado) throw new AuthError("estudio_requerido");
    if (req.headers["x-estudio"] !== sesion.tenantActivo) throw new AuthError("estudio_desfasado");
    return true;
  }
}
