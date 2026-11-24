import { Inject, Injectable, Optional, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { AuthError } from "../errores.js";
import { APP_ORIGIN } from "../inyeccion.js";
import { esMetodoSeguro, marcada, META_SIN_ORIGEN, type PeticionAuth } from "./decoradores.js";

/**
 * D6 / CA-7: en todo método que no es GET se comprueban las dos cabeceras que haya: `Origin`, si
 * viene, debe ser APP_ORIGIN exacto; `Sec-Fetch-Site`, si viene, debe ser `same-origin` (también con
 * `Origin` correcto, T16/H2). Sin ninguna de las dos, o con alguna ajena: 403 `origen_invalido`.
 * El Referer no cuenta. Las rutas marcadas `@SinOrigen()` (solo `POST /correo/baja`, 028) quedan fuera si se da el `Reflector`, salvo
 * con un cuerpo JSON (H-028-1-7): la exención es solo para la variante de un clic de RFC 8058 (urlencoded, sin `Origin`); el botón de
 * `/baja` manda JSON desde el propio origen y se comprueba como cualquier otra escritura.
 */
/** Mismo criterio que `BajaController` para elegir la variante JSON. */
const esJson = (tipo: unknown): boolean => typeof tipo === "string" && /^\s*application\/json\b/i.test(tipo);

@Injectable()
export class OrigenGuard implements CanActivate {
  constructor(
    @Inject(APP_ORIGIN) private readonly appOrigin: string,
    @Optional() private readonly reflector?: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<PeticionAuth>();
    if (esMetodoSeguro(req.method)) return true;
    if (
      this.reflector !== undefined &&
      marcada(this.reflector, ctx, META_SIN_ORIGEN) &&
      !esJson(req.headers["content-type"])
    )
      return true;
    const origen = req.headers.origin;
    const sitio = req.headers["sec-fetch-site"];
    if (origen === undefined && sitio === undefined) throw new AuthError("origen_invalido");
    if (origen !== undefined && origen !== this.appOrigin) throw new AuthError("origen_invalido");
    if (sitio !== undefined && sitio !== "same-origin") throw new AuthError("origen_invalido");
    return true;
  }
}
