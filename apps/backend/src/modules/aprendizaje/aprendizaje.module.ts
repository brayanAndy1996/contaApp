import { Module } from "@nestjs/common";
import { CandidatasController } from "./candidatas.controller.js";
import { CandidatasService } from "./candidatas.service.js";
import { ImportacionesController } from "./importaciones.controller.js";
import { ImportacionesService } from "./importaciones.service.js";

/**
 * Aprendizaje del historial (spec 025): importar el historial presentado y revisar, activar, reemplazar y descartar sus candidatas.
 * La BD y el `Encolador` llegan de los módulos globales. El backend no llama al SIRE ni depende de su paquete: solo encola (D-1).
 */
@Module({
  controllers: [ImportacionesController, CandidatasController],
  providers: [ImportacionesService, CandidatasService],
})
export class AprendizajeModule {}
