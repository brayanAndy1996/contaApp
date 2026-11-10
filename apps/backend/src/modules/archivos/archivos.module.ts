import { Module } from "@nestjs/common";
import { ArchivosComprasController, ArchivosVentasController } from "./archivos.controller.js";
import { ArchivosService } from "./archivos.service.js";

/**
 * Archivos SIRE generados (spec 012b): previo, generar, versiones y descarga de compras y de ventas. La BD, el `Encolador` y el
 * storage llegan de los módulos globales. Va ANTES de `ComprasModule` y `VentasModule` en `AppModule`: sus rutas con un parámetro
 * (`GET :compraId`) capturarían `archivos` si se registraran primero.
 */
@Module({
  controllers: [ArchivosComprasController, ArchivosVentasController],
  providers: [ArchivosService],
})
export class ArchivosModule {}
