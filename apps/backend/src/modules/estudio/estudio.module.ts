import { Module } from "@nestjs/common";
import { EstudioController } from "./estudio.controller.js";

@Module({ controllers: [EstudioController] })
export class EstudioModule {}
