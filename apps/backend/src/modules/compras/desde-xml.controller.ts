import { Body, Controller, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { FilaCompraVista, VistaPreviaDesdeXml } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { accesoDe } from "./compras-acciones.controller.js";
import { DesdeXmlComprasService } from "./desde-xml.service.js";

/**
 * Agregar una compra desde un XML (spec 016, HU-18, D-8, P-9). Permiso `sire.clasificar`, alcance por cliente (404 igual que
 * inexistente). El cuerpo es el XML crudo (≤ 1 MiB: más es 413 antes del controlador, `app.ts`); el destino y el tipo de cambio
 * viajan en la query. Va ANTES de `ComprasAccionesController` en `ComprasModule`: las rutas estáticas `desde-xml*` no se leen
 * como una compra.
 */
@Controller("clientes/:clienteId/periodos/:periodo/compras/desde-xml")
export class DesdeXmlComprasController {
  constructor(@Inject(DesdeXmlComprasService) private readonly servicio: DesdeXmlComprasService) {}

  /** 200: los campos del comprobante para prellenar el formulario. No escribe nada. */
  @Permiso("sire.clasificar")
  @Post("vista-previa")
  @HttpCode(200)
  vistaPrevia(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<VistaPreviaDesdeXml> {
    return this.servicio.vistaPrevia(sesion, accesoDe(req)[0], clienteId, periodo, cuerpo);
  }

  /** 201: la compra agregada con su XML. `?destino=DG|DGNG|DNG` (obligatorio) y `&tipoCambio=` (solo en USD). */
  @Permiso("sire.clasificar")
  @Post()
  @HttpCode(201)
  agregar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Query() query: unknown,
    @Body() cuerpo: unknown,
  ): Promise<FilaCompraVista> {
    return this.servicio.agregar(sesion, ...accesoDe(req), clienteId, periodo, query, cuerpo);
  }
}
