import { Module } from "@nestjs/common";
import { ComprasModule } from "../compras/compras.module.js";
import { EscrituraProrrataService } from "./escritura.service.js";
import { LecturaProrrataService } from "./lectura.service.js";
import { ObtencionProrrataService } from "./obtencion.service.js";
import { ProrrataController } from "./prorrata.controller.js";

/**
 * Prorrata e IGV estimado (spec 026): lectura de la ventana de 12 meses con el coeficiente y el IGV de M, «Obtener declaraciones»
 * (solo encola `sol.declaraciones.descargar`), mes manual y prorrata usada. La BD y el `Encolador` llegan de los módulos globales; las
 * compras de M salen del `ResumenComprasService` de 014 (exportado por `ComprasModule`). El backend no llama a SOL ni depende de su
 * paquete: solo encola y lee de la BD (D-3).
 */
@Module({
  imports: [ComprasModule],
  controllers: [ProrrataController],
  providers: [LecturaProrrataService, ObtencionProrrataService, EscrituraProrrataService],
})
export class ProrrataModule {}
