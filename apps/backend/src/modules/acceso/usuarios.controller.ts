import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso } from "./guards/decoradores.js";
import {
  UsuariosService,
  type EstadoMiembro,
  type Llamante,
  type MiembroRespuesta,
} from "./usuarios.service.js";

/** `PermisoGuard` ya exigió sesión, estudio activo y permiso: aquí el estudio sale solo de la sesión (D13). */
export const llamante = (s: SesionResuelta): Llamante => ({
  usuarioId: s.usuarioId,
  tenantId: s.tenantActivo as string,
});

/** Miembros del estudio (plan: Contratos HTTP de `/usuarios`). */
@Controller("usuarios")
export class UsuariosController {
  constructor(
    @Inject(UsuariosService) private readonly usuarios: UsuariosService,
  ) {}

  @Get()
  @Permiso("usuarios.ver")
  listar(@Sesion() s: SesionResuelta): Promise<MiembroRespuesta[]> {
    return this.usuarios.listar(llamante(s));
  }

  @Patch(":usuarioId/rol")
  @Permiso("usuarios.gestionar")
  cambiarRol(
    @Sesion() s: SesionResuelta,
    @Param("usuarioId") usuarioId: string,
    @Body() cuerpo: unknown,
  ): Promise<EstadoMiembro> {
    return this.usuarios.cambiarRol(llamante(s), usuarioId, cuerpo);
  }

  @Post(":usuarioId/desactivar")
  @Permiso("usuarios.gestionar")
  @HttpCode(200)
  desactivar(
    @Sesion() s: SesionResuelta,
    @Param("usuarioId") usuarioId: string,
  ): Promise<EstadoMiembro> {
    return this.usuarios.desactivar(llamante(s), usuarioId);
  }

  @Post(":usuarioId/reactivar")
  @Permiso("usuarios.gestionar")
  @HttpCode(200)
  reactivar(
    @Sesion() s: SesionResuelta,
    @Param("usuarioId") usuarioId: string,
  ): Promise<EstadoMiembro> {
    return this.usuarios.reactivar(llamante(s), usuarioId);
  }
}
