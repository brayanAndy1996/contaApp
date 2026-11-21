import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { ImportacionVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { ImportacionesService } from "./importaciones.service.js";

/**
 * Importación del historial presentado (spec 025, D-1, D-10). El permiso lo exige `PermisoGuard` (`reglas.ver` / `reglas.gestionar`)
 * y el alcance, `ClienteScopeGuard` (`:clienteId`: ajeno, no asignado e inexistente dan el mismo 404). El cuerpo llega crudo al
 * servicio, que lo valida con `@contapp/shared` (400 `solicitud_invalida`). La ruta estática `ultima` no choca con el POST.
 */
@Controller("clientes/:clienteId/reglas/importaciones")
export class ImportacionesController {
  constructor(@Inject(ImportacionesService) private readonly servicio: ImportacionesService) {}

  /** 202 `{ importacion, trabajoId }`: solo encola, nunca llama al SIRE. */
  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Post()
  @HttpCode(202)
  importar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Body() cuerpo: unknown,
  ): Promise<{ importacion: ImportacionVista; trabajoId: string }> {
    return this.servicio.importar(sesion, alcanceDe(req.acceso), clienteId, cuerpo);
  }

  @Permiso("reglas.ver")
  @Header("Cache-Control", "no-store")
  @Get("ultima")
  ultima(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
  ): Promise<{ importacion: ImportacionVista | null }> {
    return this.servicio.ultima(sesion, alcanceDe(req.acceso), clienteId);
  }
}
