import { Controller, Get, Header, Inject, Param, Req, StreamableFile } from "@nestjs/common";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { ExportarComprasService } from "./exportar.service.js";

/**
 * Excel de las compras del periodo (spec 014, D-17, RF-105). Controlador propio, registrado en `ComprasModule` ANTES de
 * `ComprasController`: si no, su `GET :compraId` capturaría `exportar.xlsx`. Permiso `clientes.ver` y alcance por cliente
 * (ajeno, no asignado e inexistente dan el mismo 404). El archivo no se cachea y su nombre solo lleva el periodo.
 */
@Controller("clientes/:clienteId/periodos/:periodo/compras")
export class ExportarComprasController {
  constructor(@Inject(ExportarComprasService) private readonly servicio: ExportarComprasService) {}

  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Get("exportar.xlsx")
  async exportar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<StreamableFile> {
    const { nombre, datos } = await this.servicio.exportar(sesion, alcanceDe(req.acceso), clienteId, periodo);
    return new StreamableFile(datos, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      disposition: `attachment; filename="${nombre}"`,
      length: datos.length,
    });
  }
}
