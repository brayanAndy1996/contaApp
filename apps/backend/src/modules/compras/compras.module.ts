import { Module } from "@nestjs/common";
import { AccionesComprasService } from "./acciones.service.js";
import { ComprasAccionesController } from "./compras-acciones.controller.js";
import { ComprasController } from "./compras.controller.js";
import { ComprasService } from "./compras.service.js";
import { DesdeXmlComprasController } from "./desde-xml.controller.js";
import { DesdeXmlComprasService } from "./desde-xml.service.js";
import { DetalleComprasController } from "./detalle.controller.js";
import { DetalleComprasService } from "./detalle.service.js";
import { ExportarComprasController } from "./exportar.controller.js";
import { ExportarComprasService } from "./exportar.service.js";
import { HistorialComprasService } from "./historial.service.js";
import { MasivasComprasService } from "./masivas.service.js";
import { PeriodoComprasService } from "./periodo.service.js";
import { ResumenComprasService } from "./resumen.service.js";
import { XmlComprasController } from "./xml.controller.js";
import { XmlComprasService } from "./xml.service.js";

/**
 * Compras del periodo (spec 014). La BD y el `Encolador` llegan de los módulos globales. Orden de `controllers`: las rutas
 * estáticas de otros controladores (`exportar.xlsx` de T17) van ANTES de `ComprasController`, que registra `GET :compraId`;
 * las escrituras de T16 (`ComprasAccionesController`, solo `POST`) no chocan con él, y dentro de ese controlador las rutas
 * estáticas (`masivas/*`, `deshacer`, `estado/*`) van antes de `:compraId/...`.
 */
@Module({
  controllers: [
    ExportarComprasController,
    DetalleComprasController,
    XmlComprasController,
    DesdeXmlComprasController,
    ComprasController,
    ComprasAccionesController,
  ],
  providers: [
    ComprasService,
    ResumenComprasService,
    ExportarComprasService,
    AccionesComprasService,
    MasivasComprasService,
    HistorialComprasService,
    PeriodoComprasService,
    DetalleComprasService,
    XmlComprasService,
    DesdeXmlComprasService,
  ],
})
export class ComprasModule {}
