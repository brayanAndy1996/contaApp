import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  AuthService,
  type EstadoSesion,
  type Estudio,
  type RespuestaLogin,
  type SesionResuelta,
} from "./auth.service.js";
import { AuthError } from "./errores.js";
import { Publico, Sesion, SesionOpcional, SinEstudio } from "./guards/decoradores.js";
import { RecuperacionService } from "./recuperacion.service.js";

const SET_COOKIE = "Set-Cookie";

/**
 * Rutas `/auth/*` (plan: Contratos HTTP). Delgado: el cuerpo llega crudo a los servicios (ellos lo
 * validan con zod) y estos devuelven la cookie que aquí se emite. Todas son `@SinEstudio()`: el estudio
 * activo no es requisito para iniciar sesión ni para elegir uno.
 */
@Controller("auth")
@SinEstudio()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RecuperacionService) private readonly recuperacion: RecuperacionService,
  ) {}

  @Post("login")
  @Publico()
  @HttpCode(200)
  async login(
    @Body() cuerpo: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RespuestaLogin> {
    const { respuesta, cookie } = await this.auth.login(cuerpo, req.ip, req.headers.cookie);
    res.setHeader(SET_COOKIE, cookie);
    return respuesta;
  }

  @Post("logout")
  @SesionOpcional()
  @HttpCode(204)
  async logout(@Sesion() sesion: SesionResuelta | null, @Res({ passthrough: true }) res: Response): Promise<void> {
    res.setHeader(SET_COOKIE, await this.auth.logout(sesion));
  }

  @Get("sesion")
  sesion(@Sesion() sesion: SesionResuelta): Promise<EstadoSesion> {
    return this.auth.estadoSesion(sesion);
  }

  @Get("estudios")
  estudios(@Sesion() sesion: SesionResuelta): Promise<(Estudio & { ultimoUsado: boolean })[]> {
    return this.auth.listarEstudios(sesion);
  }

  @Post("estudio")
  @HttpCode(200)
  async estudio(
    @Sesion() sesion: SesionResuelta,
    @Body() cuerpo: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ estudioActivo: Estudio }> {
    const { respuesta, cookie } = await this.auth.cambiarEstudio(sesion, cuerpo);
    res.setHeader(SET_COOKIE, cookie);
    return respuesta;
  }

  @Post("sesiones/cerrar-todas")
  @HttpCode(204)
  async cerrarTodas(@Sesion() sesion: SesionResuelta, @Res({ passthrough: true }) res: Response): Promise<void> {
    res.setHeader(SET_COOKIE, await this.auth.cerrarTodas(sesion));
  }

  @Post("recuperar")
  @Publico()
  @HttpCode(202)
  recuperar(@Body() cuerpo: unknown, @Req() req: Request): Promise<{ ok: true }> {
    return this.recuperacion.solicitar(cuerpo, req.ip);
  }

  @Post("recuperar/restablecer")
  @Publico()
  @HttpCode(204)
  restablecer(@Body() cuerpo: unknown, @Req() req: Request): Promise<void> {
    return this.recuperacion.restablecer(cuerpo, req.ip);
  }

  /**
   * P11. Un 401 aquí significa "la contraseña actual no coincide": se distingue del 401 de sesión
   * caducada (`sesion_invalida`) con `actual_incorrecta` para que el formulario no redirija a login.
   */
  @Post("contrasena")
  @HttpCode(204)
  async contrasena(
    @Sesion() sesion: SesionResuelta,
    @Body() cuerpo: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    try {
      res.setHeader(SET_COOKIE, await this.auth.cambiarContrasena(sesion, cuerpo));
    } catch (e) {
      if (e instanceof AuthError && e.codigo === "credenciales_invalidas") throw new AuthError("actual_incorrecta");
      throw e;
    }
  }
}
