import { Module } from "@nestjs/common";
import { MotorReglasController } from "./motor.controller.js";
import { MotorReglasService } from "./motor.service.js";
import { ReglasController } from "./reglas.controller.js";
import { ReglasService } from "./reglas.service.js";

/** Reglas aprendidas del cliente y reglas del motor del estudio (spec 021). La BD llega del módulo global del núcleo. */
@Module({
  controllers: [ReglasController, MotorReglasController],
  providers: [ReglasService, MotorReglasService],
})
export class ReglasModule {}
