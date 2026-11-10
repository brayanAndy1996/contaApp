import { Controller, Get, Header, HttpCode, Inject, Param, Post, Req, StreamableFile } from "@nestjs/common";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { XmlComprasService } from "./xml.service.js";

/**
 * XML del comprobante (spec 016, D-8). Leer y descargar: `clientes.ver`; pedirlo: `sire.clasificar`. El alcance lo exige
 * `ClienteScopeGuard` y la compra, el servicio: todo lo ajeno, inexistente o mal formado da el mismo 404. Va ANTES de
 * `ComprasController` en `ComprasModule`.
 */
@Controller("clientes/:clienteId/periodos/:periodo/compras")
export class XmlComprasController {
  constructor(@Inject(XmlComprasService) private readonly servicio: XmlComprasService) {}

  /**
   * Los bytes guardados como ADJUNTO, `application/xml` y `nosniff`: un XML con `<script>` en la glosa jamás se interpreta como
   * HTML en el navegador. Sin XML, 404.
   */
  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Header("X-Content-Type-Options", "nosniff")
  @Get(":compraId/xml")
  async descargar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
  ): Promise<StreamableFile> {
    const { nombre, bytes } = await this.servicio.descargar(sesion, alcanceDe(req.acceso), clienteId, periodo, compraId);
    return new StreamableFile(bytes, {
      type: "application/xml",
      disposition: `attachment; filename="${nombre}"`,
      length: bytes.length,
    });
  }

  /** 202 `{ trabajoId }`: solo encola, nunca llama a SUNAT. */
  @Permiso("sire.clasificar")
  @Post(":compraId/xml/obtener")
  @HttpCode(202)
  obtener(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
  ): Promise<{ trabajoId: string }> {
    return this.servicio.obtener(sesion, alcanceDe(req.acceso), clienteId, periodo, compraId);
  }
}
