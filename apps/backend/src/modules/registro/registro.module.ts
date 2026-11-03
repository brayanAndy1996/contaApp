import { Module } from "@nestjs/common";
import { RegistroController } from "./registro.controller.js";
import { RegistroService } from "./registro.service.js";

/** Registro público de estudio (spec 006, D3). Las dependencias las aporta `NucleoModule` (global). */
@Module({
  controllers: [RegistroController],
  providers: [RegistroService],
})
export class RegistroModule {}
