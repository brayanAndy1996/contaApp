import { Module } from "@nestjs/common";
import { CredencialesModule } from "../credenciales/credenciales.module.js";
import { ImportacionController } from "./importacion.controller.js";
import { ImportacionService } from "./importacion.service.js";

/** Importación de clientes (spec 007b, D7–D9). El `KeyWrapper` llega de `CredencialesModule` y el `Encolador`, del módulo global. */
@Module({
  imports: [CredencialesModule],
  controllers: [ImportacionController],
  providers: [ImportacionService],
})
export class ImportacionModule {}
