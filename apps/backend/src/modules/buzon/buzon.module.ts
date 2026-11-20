import { Module } from "@nestjs/common";
import { BuzonController } from "./buzon.controller.js";
import { LecturaBuzonService } from "./lectura.service.js";
import { SolicitudBuzonService } from "./solicitud.service.js";

/** Buzón SOL del cliente (spec 023): «Revisar ahora», lectura, «Abrir» y descarga de adjuntos. BD, `Encolador` y storage llegan de los módulos globales. */
@Module({
  controllers: [BuzonController],
  providers: [SolicitudBuzonService, LecturaBuzonService],
})
export class BuzonModule {}
