import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Publico, Sesion, SinEstudio } from "../auth/guards/decoradores.js";
import { Permiso } from "./guards/decoradores.js";
import {
  InvitacionesService,
  type AceptadaConSesion,
  type InvitacionConsultada,
  type InvitacionRespuesta,
} from "./invitaciones.service.js";
import { llamante } from "./usuarios.controller.js";

/**
 * Invitaciones (plan: Contratos HTTP de `/invitaciones`). `consultar` y `aceptar` son públicas (con
 * `OrigenGuard`) y POST: el token nunca va en la URL. `aceptar-con-sesion` exige sesión y CSRF, sin estudio.
 */
@Controller("invitaciones")
export class InvitacionesController {
  constructor(
    @Inject(InvitacionesService)
    private readonly invitaciones: InvitacionesService,
  ) {}

  @Get()
  @Permiso("usuarios.ver")
  listar(@Sesion() s: SesionResuelta): Promise<InvitacionRespuesta[]> {
    return this.invitaciones.listar(llamante(s));
  }

  @Post()
  @Permiso("usuarios.gestionar")
  invitar(
    @Sesion() s: SesionResuelta,
    @Body() cuerpo: unknown,
  ): Promise<InvitacionRespuesta> {
    return this.invitaciones.invitar(llamante(s), cuerpo);
  }

  @Post("consultar")
  @Publico()
  @HttpCode(200)
  consultar(@Body() cuerpo: unknown): Promise<InvitacionConsultada> {
    return this.invitaciones.consultar(cuerpo);
  }

  @Post("aceptar")
  @Publico()
  @HttpCode(204)
  aceptar(@Body() cuerpo: unknown): Promise<void> {
    return this.invitaciones.aceptar(cuerpo);
  }

  @Post("aceptar-con-sesion")
  @SinEstudio()
  @HttpCode(200)
  aceptarConSesion(
    @Sesion() s: SesionResuelta,
    @Body() cuerpo: unknown,
    @Headers("x-estudio") xEstudio: string | undefined,
  ): Promise<AceptadaConSesion> {
    return this.invitaciones.aceptarConSesion(s, cuerpo, xEstudio);
  }

  @Post(":invitacionId/reenviar")
  @Permiso("usuarios.gestionar")
  @HttpCode(200)
  reenviar(
    @Sesion() s: SesionResuelta,
    @Param("invitacionId") id: string,
  ): Promise<InvitacionRespuesta> {
    return this.invitaciones.reenviar(llamante(s), id);
  }

  @Post(":invitacionId/revocar")
  @Permiso("usuarios.gestionar")
  @HttpCode(204)
  revocar(
    @Sesion() s: SesionResuelta,
    @Param("invitacionId") id: string,
  ): Promise<void> {
    return this.invitaciones.revocar(llamante(s), id);
  }
}
