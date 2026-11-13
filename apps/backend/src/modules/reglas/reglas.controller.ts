import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { ReglaVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { ReglasService } from "./reglas.service.js";

/**
 * Reglas aprendidas del cliente (spec 021). El permiso lo exige `PermisoGuard` (`reglas.ver` / `reglas.gestionar`) y el alcance,
 * `ClienteScopeGuard` (`:clienteId`: ajeno, no asignado e inexistente dan el mismo 404). Cuerpo y query llegan crudos al servicio,
 * que los valida con `@contapp/shared` (400 `solicitud_invalida`). La ruta estática `recordar` va antes de `:reglaId`.
 */
@Controller("clientes/:clienteId/reglas")
export class ReglasController {
  constructor(@Inject(ReglasService) private readonly servicio: ReglasService) {}

  @Permiso("reglas.ver")
  @Header("Cache-Control", "no-store")
  @Get()
  listar(@Sesion() sesion: SesionResuelta, @Req() req: PeticionAcceso, @Param("clienteId") clienteId: string): Promise<ReglaVista[]> {
    return this.servicio.listar(sesion, alcanceDe(req.acceso), clienteId);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Post("recordar")
  @HttpCode(200)
  recordar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Body() cuerpo: unknown,
  ): Promise<ReglaVista> {
    return this.servicio.recordar(sesion, alcanceDe(req.acceso), clienteId, cuerpo);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Patch(":reglaId")
  @HttpCode(200)
  editar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("reglaId") reglaId: string,
    @Body() cuerpo: unknown,
  ): Promise<ReglaVista> {
    return this.servicio.editar(sesion, alcanceDe(req.acceso), clienteId, reglaId, cuerpo);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Delete(":reglaId")
  @HttpCode(204)
  eliminar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("reglaId") reglaId: string,
    @Query() query: unknown,
  ): Promise<void> {
    return this.servicio.eliminar(sesion, alcanceDe(req.acceso), clienteId, reglaId, query);
  }
}
