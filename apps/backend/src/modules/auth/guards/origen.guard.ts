import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AuthError } from "../errores.js";
import { APP_ORIGIN } from "../inyeccion.js";
import { esMetodoSeguro, type PeticionAuth } from "./decoradores.js";

/**
 * D6 / CA-7: en todo método que no es GET se comprueban las dos cabeceras que haya: `Origin`, si
 * viene, debe ser APP_ORIGIN exacto; `Sec-Fetch-Site`, si viene, debe ser `same-origin` (también con
 * `Origin` correcto, T16/H2). Sin ninguna de las dos, o con alguna ajena: 403 `origen_invalido`.
 * El Referer no cuenta.
 */
@Injectable()
export class OrigenGuard implements CanActivate {
  constructor(@Inject(APP_ORIGIN) private readonly appOrigin: string) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<PeticionAuth>();
    if (esMetodoSeguro(req.method)) return true;
    const origen = req.headers.origin;
    const sitio = req.headers["sec-fetch-site"];
    if (origen === undefined && sitio === undefined) throw new AuthError("origen_invalido");
    if (origen !== undefined && origen !== this.appOrigin) throw new AuthError("origen_invalido");
    if (sitio !== undefined && sitio !== "same-origin") throw new AuthError("origen_invalido");
    return true;
  }
}
