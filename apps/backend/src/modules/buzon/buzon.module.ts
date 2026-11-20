import { Module } from "@nestjs/common";
import { AtencionBuzonService } from "./atencion.service.js";
import { BandejaController } from "./bandeja.controller.js";
import { BandejaBuzonService } from "./bandeja.service.js";
import { BuzonController } from "./buzon.controller.js";
import { LecturaBuzonService } from "./lectura.service.js";
import { SolicitudBuzonService } from "./solicitud.service.js";

/**
 * Buzón SOL del cliente (spec 023): «Revisar ahora», lectura, «Abrir» y descarga de adjuntos; y la bandeja con la atención (spec 024).
 * BD, `Encolador` y storage llegan de los módulos globales.
 */
@Module({
  controllers: [BuzonController, BandejaController],
  providers: [SolicitudBuzonService, LecturaBuzonService, BandejaBuzonService, AtencionBuzonService],
})
export class BuzonModule {}
