import { Module } from "@nestjs/common";
import { ComprasController } from "./compras.controller.js";
import { ComprasService } from "./compras.service.js";
import { ExportarComprasController } from "./exportar.controller.js";
import { ExportarComprasService } from "./exportar.service.js";
import { ResumenComprasService } from "./resumen.service.js";

/**
 * Compras del periodo (spec 014). La BD y el `Encolador` llegan de los módulos globales. Orden de `controllers`: las rutas
 * estáticas de otros controladores (`exportar.xlsx` de T17) van ANTES de `ComprasController`, que registra `GET :compraId`;
 * las acciones de T16 (`POST :compraId/...`, `POST masivas/...`) no chocan con él.
 */
@Module({
  controllers: [ExportarComprasController, ComprasController],
  providers: [ComprasService, ResumenComprasService, ExportarComprasService],
})
export class ComprasModule {}
