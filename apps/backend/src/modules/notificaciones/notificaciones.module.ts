import { Module } from "@nestjs/common";
import { NotificacionesController } from "./notificaciones.controller.js";
import { NotificacionesService } from "./notificaciones.service.js";

/**
 * Lectura y marcado de notificaciones (spec 017). El `Notificador` (aviso en vivo por Redis) lo provee y exporta
 * `TrabajosModule`, que posee la conexión.
 */
@Module({
  controllers: [NotificacionesController],
  providers: [NotificacionesService],
})
export class NotificacionesModule {}
