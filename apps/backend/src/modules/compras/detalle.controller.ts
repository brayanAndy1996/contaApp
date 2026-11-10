import { Controller, Get, Header, Inject, Param, Req } from "@nestjs/common";
import type { DetalleLupa } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { DetalleComprasService } from "./detalle.service.js";

/**
 * Lupa del comprobante (spec 016, D-8). Permiso `clientes.ver` y alcance por cliente (`ClienteScopeGuard`: ajeno, no asignado
 * e inexistente dan el mismo 404). Va ANTES de `ComprasController` en `ComprasModule`, como los demás con rutas propias.
 */
@Controller("clientes/:clienteId/periodos/:periodo/compras")
export class DetalleComprasController {
  constructor(@Inject(DetalleComprasService) private readonly servicio: DetalleComprasService) {}

  /** 200 `DetalleCompraDto`; 404 si la compra es de otro cliente, periodo o estudio. Glosas y razones sociales son texto. */
  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Header("X-Content-Type-Options", "nosniff")
  @Get(":compraId/detalle")
  detalle(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
  ): Promise<DetalleLupa> {
    return this.servicio.detalle(sesion, alcanceDe(req.acceso), clienteId, periodo, compraId);
  }
}
