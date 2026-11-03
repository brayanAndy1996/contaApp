import { Module } from "@nestjs/common";
import { PlanesController } from "./planes.controller.js";
import { PlanesService } from "./planes.service.js";

/** Uso del plan del estudio (spec 006). Los adaptadores de cupo los aporta `NucleoModule` (global). */
@Module({
  controllers: [PlanesController],
  providers: [PlanesService],
})
export class PlanesModule {}
