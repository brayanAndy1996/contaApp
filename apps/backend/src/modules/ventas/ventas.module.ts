import { Module } from "@nestjs/common";
import { ImportarPropuestaService } from "./importar-propuesta.service.js";
import { VentasController } from "./ventas.controller.js";
import { VentasService } from "./ventas.service.js";

/** Ventas del periodo (spec 013, D2, D5 a D11). La BD y el `Encolador` llegan de los módulos globales. */
@Module({
  controllers: [VentasController],
  providers: [VentasService, ImportarPropuestaService],
})
export class VentasModule {}
