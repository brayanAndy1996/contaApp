import { Module } from "@nestjs/common";
import { PlataformaController } from "./plataforma.controller.js";
import { PlataformaService } from "./plataforma.service.js";

/** Planes, estudios y suscripciones del super-admin (spec 006, D5, D13). `DB` lo aporta `NucleoModule` (global). */
@Module({
  controllers: [PlataformaController],
  providers: [PlataformaService],
})
export class PlataformaModule {}
