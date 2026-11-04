import { Module } from "@nestjs/common";
import { ImportacionController } from "./importacion.controller.js";

/** Importación de clientes (spec 007b, D7–D9). T12 añade el servicio de vista previa y confirmación. */
@Module({
  controllers: [ImportacionController],
})
export class ImportacionModule {}
