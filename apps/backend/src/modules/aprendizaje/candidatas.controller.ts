import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { CandidataVista, ReglaVista, RespuestaActivar, RespuestaDescartar } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { CandidatasService } from "./candidatas.service.js";

/**
 * Candidatas del historial (spec 025, D-4 a D-7, D-10). El permiso lo exige `PermisoGuard` y el alcance, `ClienteScopeGuard`.
 * Cuerpo y query llegan crudos al servicio, que los valida con `@contapp/shared` (400 `solicitud_invalida`). Las rutas estáticas
 * (`activar`, `descartar`) van antes de `:candidataId/reemplazar`; activar y descartar tienen un límite de cuerpo propio (app.ts).
 */
@Controller("clientes/:clienteId/reglas/candidatas")
export class CandidatasController {
  constructor(@Inject(CandidatasService) private readonly servicio: CandidatasService) {}

  @Permiso("reglas.ver")
  @Header("Cache-Control", "no-store")
  @Get()
  listar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Query() query: unknown,
  ): Promise<{ candidatas: CandidataVista[]; siguiente: string | null }> {
    return this.servicio.listar(sesion, alcanceDe(req.acceso), clienteId, query);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Post("activar")
  @HttpCode(200)
  activar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Body() cuerpo: unknown,
  ): Promise<RespuestaActivar> {
    return this.servicio.activar(sesion, alcanceDe(req.acceso), clienteId, cuerpo);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Post("descartar")
  @HttpCode(200)
  descartar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Body() cuerpo: unknown,
  ): Promise<RespuestaDescartar> {
    return this.servicio.descartar(sesion, alcanceDe(req.acceso), clienteId, cuerpo);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Post(":candidataId/reemplazar")
  @HttpCode(200)
  reemplazar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("candidataId") candidataId: string,
    @Body() cuerpo: unknown,
  ): Promise<{ regla: ReglaVista }> {
    return this.servicio.reemplazar(sesion, alcanceDe(req.acceso), clienteId, candidataId, cuerpo);
  }
}
