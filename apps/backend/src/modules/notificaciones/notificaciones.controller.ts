import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { Marcadas, NoLeidas, PaginaNotificaciones } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { SoloEstudio } from "../acceso/guards/decoradores.js";
import { NotificacionesService } from "./notificaciones.service.js";

/**
 * Notificaciones del usuario de la sesión (spec 017, D-11). Las cuatro rutas son `@SoloEstudio`: cualquier miembro activo
 * lee las suyas; el alcance sobre `cliente_id` lo aplica el servicio. Las rutas estáticas van antes de `:id`.
 */
@Controller("notificaciones")
export class NotificacionesController {
  constructor(@Inject(NotificacionesService) private readonly servicio: NotificacionesService) {}

  @SoloEstudio()
  @Get()
  @Header("Cache-Control", "no-store")
  listar(@Sesion() sesion: SesionResuelta, @Query() query: unknown): Promise<PaginaNotificaciones> {
    return this.servicio.listar(sesion, query);
  }

  @SoloEstudio()
  @Get("no-leidas")
  @Header("Cache-Control", "no-store")
  noLeidas(@Sesion() sesion: SesionResuelta, @Query() query: unknown): Promise<NoLeidas> {
    return this.servicio.noLeidas(sesion, query);
  }

  @SoloEstudio()
  @Post("leidas")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  marcarHasta(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown): Promise<Marcadas> {
    return this.servicio.marcarHasta(sesion, cuerpo);
  }

  @SoloEstudio()
  @Post(":id/leida")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  marcar(@Sesion() sesion: SesionResuelta, @Param("id") id: string, @Body() cuerpo: unknown): Promise<void> {
    return this.servicio.marcar(sesion, id, cuerpo);
  }
}
