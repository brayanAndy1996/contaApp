import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type {
  CorrelatividadVentasDto,
  DiferenciaVentasDto,
  PaginaVentasDto,
  PropuestaVentasDto,
  ResumenVentasDto,
  SaltoJustificadoDto,
  VentaDto,
} from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { VentasService } from "./ventas.service.js";

/**
 * Ventas de un cliente y periodo (spec 013, D2, D5 a D11). El permiso lo exige `PermisoGuard` (leer: `clientes.ver`;
 * descargar: `sire.descargar`; agregar, quitar y justificar: `sire.clasificar`) y el alcance, `ClienteScopeGuard`
 * (`:clienteId`: ajeno, no asignado e inexistente dan el mismo 404). El periodo, el cuerpo y la query llegan crudos al
 * servicio, que los valida (400 `solicitud_invalida`). La importación del layout provisional va en T14.
 */
@Controller("clientes/:clienteId/periodos/:periodo/ventas")
export class VentasController {
  constructor(@Inject(VentasService) private readonly servicio: VentasService) {}

  /** 202 `{ trabajoId }`: solo encola, nunca llama a SUNAT. */
  @Permiso("sire.descargar")
  @Post("descargar")
  @HttpCode(202)
  descargar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<{ trabajoId: string }> {
    return this.servicio.descargar(sesion, alcanceDe(req.acceso), clienteId, periodo);
  }

  @Permiso("clientes.ver")
  @Get()
  listar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Query() query: unknown,
  ): Promise<PaginaVentasDto> {
    return this.servicio.listar(sesion, alcanceDe(req.acceso), clienteId, periodo, query);
  }

  @Permiso("clientes.ver")
  @Get("resumen")
  resumen(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<ResumenVentasDto> {
    return this.servicio.resumen(sesion, alcanceDe(req.acceso), clienteId, periodo);
  }

  @Permiso("clientes.ver")
  @Get("correlatividad")
  correlatividad(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<CorrelatividadVentasDto> {
    return this.servicio.correlatividad(sesion, alcanceDe(req.acceso), clienteId, periodo);
  }

  @Permiso("clientes.ver")
  @Get("propuestas")
  propuestas(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<PropuestaVentasDto[]> {
    return this.servicio.propuestas(sesion, alcanceDe(req.acceso), clienteId, periodo);
  }

  @Permiso("clientes.ver")
  @Get("propuestas/:propuestaId/diferencias")
  diferencias(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("propuestaId") propuestaId: string,
  ): Promise<DiferenciaVentasDto[]> {
    return this.servicio.diferencias(sesion, alcanceDe(req.acceso), clienteId, periodo, propuestaId);
  }

  /** 201 `VentaDto` de la venta agregada a mano. */
  @Permiso("sire.clasificar")
  @Post()
  agregar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<VentaDto> {
    return this.servicio.agregar(sesion, alcanceDe(req.acceso), clienteId, periodo, cuerpo);
  }

  /** 201 `{ id, tipo, serie, desde, hasta, comentario }`. */
  @Permiso("sire.clasificar")
  @Post("saltos-justificados")
  justificar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<SaltoJustificadoDto> {
    return this.servicio.justificar(sesion, alcanceDe(req.acceso), clienteId, periodo, cuerpo);
  }

  /** 204: la fila queda revertida (con quién y cuándo), no se borra. */
  @Permiso("sire.clasificar")
  @Delete("saltos-justificados/:justificacionId")
  @HttpCode(204)
  revertir(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("justificacionId") justificacionId: string,
  ): Promise<void> {
    return this.servicio.revertir(sesion, alcanceDe(req.acceso), clienteId, periodo, justificacionId);
  }

  /** 204: solo una venta `manual`; la del SIRE es inmutable (409). */
  @Permiso("sire.clasificar")
  @Delete(":ventaId")
  @HttpCode(204)
  quitar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("ventaId") ventaId: string,
  ): Promise<void> {
    return this.servicio.quitar(sesion, alcanceDe(req.acceso), clienteId, periodo, ventaId);
  }
}
