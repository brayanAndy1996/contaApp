import { Module } from "@nestjs/common";
import { AuditoriaController } from "./auditoria.controller.js";
import { AuditoriaService } from "./auditoria.service.js";

/** Consulta de auditoría (spec 017). La escritura es de la BD (triggers); aquí solo se lee. */
@Module({
  controllers: [AuditoriaController],
  providers: [AuditoriaService],
})
export class AuditoriaModule {}
