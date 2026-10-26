import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AuthError } from "../errores.js";
import { APP_ORIGIN } from "../inyeccion.js";
import { esMetodoSeguro, type PeticionAuth } from "./decoradores.js";

/**
 * D6 / CA-7: en todo método que no es GET, `Origin` debe ser APP_ORIGIN exacto; sin `Origin`,
 * `Sec-Fetch-Site` debe ser `same-origin`. Si no, 403 `origen_invalido`. El Referer no cuenta.
 */
@Injectable()
export class OrigenGuard implements CanActivate {
  constructor(@Inject(APP_ORIGIN) private readonly appOrigin: string) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<PeticionAuth>();
    if (esMetodoSeguro(req.method)) return true;
    const origen = req.headers.origin;
    if (origen !== undefined) {
      if (origen === this.appOrigin) return true;
      throw new AuthError("origen_invalido");
    }
    if (req.headers["sec-fetch-site"] === "same-origin") return true;
    throw new AuthError("origen_invalido");
  }
}
