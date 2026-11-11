import { Module } from "@nestjs/common";
import { EstadoVentasService } from "./estado.service.js";
import { ExclusionVentasService } from "./exclusion.service.js";
import { ImportarPropuestaService } from "./importar-propuesta.service.js";
import { VentasController } from "./ventas.controller.js";
import { VentasService } from "./ventas.service.js";

/** Ventas del periodo (spec 013, D2, D5 a D11; 012b: estado del periodo y exclusión). La BD y el `Encolador` llegan de los módulos globales. */
@Module({
  controllers: [VentasController],
  providers: [VentasService, ImportarPropuestaService, EstadoVentasService, ExclusionVentasService],
})
export class VentasModule {}
