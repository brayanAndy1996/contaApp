import { Module } from "@nestjs/common";
import { AsignacionesController } from "./asignaciones.controller.js";
import { AsignacionesService } from "./asignaciones.service.js";
import { ClientesController } from "./clientes.controller.js";

/** Clientes visibles y asignaciones (spec 005, T11). */
@Module({
  controllers: [ClientesController, AsignacionesController],
  providers: [AsignacionesService],
})
export class ClientesModule {}
