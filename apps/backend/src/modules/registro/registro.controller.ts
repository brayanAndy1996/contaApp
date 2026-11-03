import { Body, Controller, Headers, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Publico, Sesion, SinEstudio } from "../auth/guards/decoradores.js";
import {
  RegistroService,
  type RegistroConfirmadoConSesion,
  type RegistroConsultado,
} from "./registro.service.js";

/**
 * Registro público de estudio (plan 006: Contratos HTTP). Las tres primeras rutas son públicas (con
 * `OrigenGuard`) y POST: el token nunca va en la URL. `confirmar-con-sesion` exige sesión y CSRF, sin estudio.
 */
@Controller("registro")
export class RegistroController {
  constructor(@Inject(RegistroService) private readonly registro: RegistroService) {}

  @Post()
  @Publico()
  @HttpCode(202)
  solicitar(@Body() cuerpo: unknown, @Req() req: Request): Promise<{ ok: true }> {
    return this.registro.solicitar(cuerpo, req.ip);
  }

  @Post("consultar")
  @Publico()
  @HttpCode(200)
  consultar(@Body() cuerpo: unknown): Promise<RegistroConsultado> {
    return this.registro.consultar(cuerpo);
  }

  @Post("confirmar")
  @Publico()
  @HttpCode(204)
  confirmar(@Body() cuerpo: unknown, @Req() req: Request): Promise<void> {
    return this.registro.confirmar(cuerpo, req.ip);
  }

  @Post("confirmar-con-sesion")
  @SinEstudio()
  @HttpCode(200)
  confirmarConSesion(
    @Sesion() s: SesionResuelta,
    @Body() cuerpo: unknown,
    @Headers("x-estudio") xEstudio: string | undefined,
  ): Promise<RegistroConfirmadoConSesion> {
    return this.registro.confirmarConSesion(s, cuerpo, xEstudio);
  }
}
