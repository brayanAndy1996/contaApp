import { Module } from "@nestjs/common";
import { BajaController } from "./baja.controller.js";
import { BajaService } from "./baja.service.js";
import { PreferenciasController } from "./preferencias.controller.js";
import { PreferenciasService } from "./preferencias.service.js";

/**
 * Correo de avisos y resumen (spec 028): preferencias del usuario (`/cuenta/correo`) y baja por enlace (`/correo/baja`). El backend solo
 * guarda preferencias y aplica la baja: no crea envíos ni importa `@contapp/correo`; el worker es el único que envía.
 */
@Module({
  controllers: [PreferenciasController, BajaController],
  providers: [PreferenciasService, BajaService],
})
export class CorreoModule {}
