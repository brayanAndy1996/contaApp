import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { SesionCuenta } from "@contapp/shared";
import { origenDe, type RespuestaLogin, type SesionResuelta } from "../auth.service.js";
import { PermitirPendiente, PermitirSinFactor, Sesion, SinEstudio } from "../guards/decoradores.js";
import { SesionesService } from "./sesiones.service.js";
import { TotpService } from "./totp.service.js";

const SET_COOKIE = "Set-Cookie";

/**
 * Rutas de la cuenta segura (spec 029, plan: Contratos HTTP). Todas `@SinEstudio` (sesión sin estudio activo) con Origen y CSRF de 004;
 * solo `2fa/verificar` admite la sesión `pendiente`. Sin el factor exigido solo atienden las `@PermitirSinFactor()` (lista cerrada). `Cache-Control: no-store` lo pone la app en toda respuesta. Delgado: los servicios
 * validan el cuerpo con zod y devuelven la cookie que aquí se emite.
 */
@Controller("auth")
@SinEstudio()
export class TotpController {
  constructor(
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(SesionesService) private readonly sesiones: SesionesService,
  ) {}

  @Post("2fa/verificar")
  @PermitirPendiente()
  @PermitirSinFactor()
  @HttpCode(200)
  async verificar(
    @Sesion() sesion: SesionResuelta,
    @Body() cuerpo: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RespuestaLogin> {
    const { respuesta, cookie } = await this.totp.verificar(sesion, cuerpo, origenDe(req.headers["user-agent"], req.ip));
    res.setHeader(SET_COOKIE, cookie);
    return respuesta;
  }

  @Post("totp/enrolar")
  @PermitirSinFactor()
  @HttpCode(200)
  enrolar(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown): Promise<{ uri: string }> {
    return this.totp.enrolar(sesion, cuerpo);
  }

  @Post("totp/confirmar")
  @PermitirSinFactor()
  @HttpCode(200)
  async confirmar(
    @Sesion() sesion: SesionResuelta,
    @Body() cuerpo: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ codigosRecuperacion: string[] }> {
    const { respuesta, cookie } = await this.totp.confirmar(sesion, cuerpo, origenDe(req.headers["user-agent"], req.ip));
    res.setHeader(SET_COOKIE, cookie);
    return respuesta;
  }

  @Post("totp/desactivar")
  @HttpCode(204)
  desactivar(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown, @Req() req: Request): Promise<void> {
    return this.totp.desactivar(sesion, cuerpo, origenDe(req.headers["user-agent"], req.ip));
  }

  @Post("totp/recuperacion")
  @HttpCode(200)
  regenerar(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown): Promise<{ codigosRecuperacion: string[] }> {
    return this.totp.regenerar(sesion, cuerpo);
  }

  @Get("sesiones")
  listar(@Sesion() sesion: SesionResuelta): Promise<SesionCuenta[]> {
    return this.sesiones.listar(sesion);
  }

  @Post("sesiones/revocar-otras")
  @HttpCode(204)
  revocarOtras(@Sesion() sesion: SesionResuelta): Promise<void> {
    return this.sesiones.revocarOtras(sesion);
  }

  @Post("sesiones/:id/revocar")
  @HttpCode(204)
  revocar(@Sesion() sesion: SesionResuelta, @Param("id") id: string): Promise<void> {
    return this.sesiones.revocar(sesion, id);
  }
}
