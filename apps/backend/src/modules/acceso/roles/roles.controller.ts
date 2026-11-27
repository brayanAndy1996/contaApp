import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import type { ImpactoRol } from "@contapp/db";
import type { SesionResuelta } from "../../auth/auth.service.js";
import { Sesion } from "../../auth/guards/decoradores.js";
import { Permiso } from "../guards/decoradores.js";
import { llamante } from "../usuarios.controller.js";
import {
  RolesService,
  type Asignables,
  type ListaRoles,
  type RolRespuesta,
} from "./roles.service.js";

/** Roles propios del estudio (plan 030: Contratos HTTP de `/roles`). El estudio sale solo de la sesión (D13). */
@Controller("roles")
export class RolesController {
  constructor(@Inject(RolesService) private readonly roles: RolesService) {}

  @Get()
  @Permiso("roles.gestionar")
  listar(@Sesion() s: SesionResuelta): Promise<ListaRoles> {
    return this.roles.listar(llamante(s));
  }

  /** Lo que `usuarios.gestionar` puede asignar al invitar o cambiar de rol (la ruta fija va antes de `:id`). */
  @Get("asignables")
  @Permiso("usuarios.gestionar")
  asignables(@Sesion() s: SesionResuelta): Promise<Asignables> {
    return this.roles.asignables(llamante(s));
  }

  @Post()
  @Permiso("roles.gestionar")
  crear(@Sesion() s: SesionResuelta, @Body() cuerpo: unknown): Promise<RolRespuesta> {
    return this.roles.crear(llamante(s), cuerpo);
  }

  @Post(":rolId/impacto")
  @Permiso("roles.gestionar")
  @HttpCode(200)
  impacto(
    @Sesion() s: SesionResuelta,
    @Param("rolId") rolId: string,
    @Body() cuerpo: unknown,
  ): Promise<ImpactoRol> {
    return this.roles.impacto(llamante(s), rolId, cuerpo);
  }

  @Patch(":rolId")
  @Permiso("roles.gestionar")
  editar(
    @Sesion() s: SesionResuelta,
    @Param("rolId") rolId: string,
    @Body() cuerpo: unknown,
  ): Promise<RolRespuesta> {
    return this.roles.editar(llamante(s), rolId, cuerpo);
  }

  @Delete(":rolId")
  @Permiso("roles.gestionar")
  @HttpCode(204)
  eliminar(@Sesion() s: SesionResuelta, @Param("rolId") rolId: string): Promise<void> {
    return this.roles.eliminar(llamante(s), rolId);
  }
}
