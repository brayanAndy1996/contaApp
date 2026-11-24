import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { Publico, SinEstudio, SinOrigen } from "../auth/guards/decoradores.js";
import { BajaService } from "./baja.service.js";
import { CorreoError } from "./errores.js";

/**
 * Baja pública (spec 028, CA-8). `@Publico` + `@SinEstudio` + `@SinOrigen`: sin sesión, sin CSRF y sin `Origin` (el servidor del correo no lo
 * manda). Un cuerpo `application/json` es la variante de la página (`{token}`); cualquier otro es la de RFC 8058 (token en la consulta y
 * cuerpo crudo `List-Unsubscribe=One-Click`, leído como bytes por `app.ts`). Ningún `GET` cambia estado: 405. Nada de esto se registra.
 */
@Controller("correo/baja")
export class BajaController {
  constructor(@Inject(BajaService) private readonly servicio: BajaService) {}

  @Publico()
  @SinEstudio()
  @SinOrigen()
  @Post()
  @HttpCode(200)
  baja(@Req() req: Request, @Body() cuerpo: unknown, @Query("t") t: unknown): Promise<Record<string, never>> {
    const tipo = req.headers["content-type"];
    if (typeof tipo === "string" && /^\s*application\/json\b/i.test(tipo)) return this.servicio.confirmar(cuerpo, req.ip);
    return this.servicio.unClic(t, cuerpo, req.ip);
  }

  @Publico()
  @SinEstudio()
  @Get()
  noPermitido(): never {
    throw new CorreoError("metodo_no_permitido");
  }
}
