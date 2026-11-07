import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type {
  DetalleCompra,
  DiferenciaComprasDto,
  ListadoCompras,
  PropuestaComprasDto,
  ResumenComprasVista,
} from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { AccesoError } from "../acceso/errores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { ComprasService } from "./compras.service.js";
import { ResumenComprasService } from "./resumen.service.js";

/**
 * Compras de un cliente y periodo (spec 014, D-3, D-6, D-8, D-11, D-13, DU-19). El permiso lo exige `PermisoGuard` (leer:
 * `clientes.ver`; descargar: `sire.descargar`) y el alcance, `ClienteScopeGuard` (`:clienteId`: ajeno, no asignado e inexistente
 * dan el mismo 404). El periodo y la query llegan crudos al servicio, que los valida (400 `solicitud_invalida`).
 *
 * Orden de rutas: las estáticas (`descargar`, `resumen`, `propuestas`) van antes de `:compraId`. `exportar.xlsx` (T17) va en un
 * controlador propio que se registra ANTES de este en `ComprasModule`, o `:compraId` lo capturaría.
 */
@Controller("clientes/:clienteId/periodos/:periodo/compras")
export class ComprasController {
  constructor(
    @Inject(ComprasService) private readonly servicio: ComprasService,
    @Inject(ResumenComprasService) private readonly resumenes: ResumenComprasService,
  ) {}

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
    if (req.acceso === undefined) throw new AccesoError("permiso_denegado");
    return this.servicio.descargar(sesion, alcanceDe(req.acceso), req.acceso.permisos, clienteId, periodo);
  }

  @Permiso("clientes.ver")
  @Get()
  listar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Query() query: unknown,
  ): Promise<ListadoCompras> {
    return this.servicio.listar(sesion, alcanceDe(req.acceso), clienteId, periodo, query);
  }

  @Permiso("clientes.ver")
  @Get("resumen")
  resumen(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<ResumenComprasVista> {
    return this.resumenes.resumen(sesion, alcanceDe(req.acceso), clienteId, periodo);
  }

  @Permiso("clientes.ver")
  @Get("propuestas")
  propuestas(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<PropuestaComprasDto[]> {
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
  ): Promise<DiferenciaComprasDto[]> {
    return this.servicio.diferencias(sesion, alcanceDe(req.acceso), clienteId, periodo, propuestaId);
  }

  /** 200 `{ original, vigente, versiones, hallazgos }`; 404 si es de otro cliente, periodo o estudio. */
  @Permiso("clientes.ver")
  @Get(":compraId")
  detalle(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
  ): Promise<DetalleCompra> {
    return this.servicio.detalle(sesion, alcanceDe(req.acceso), clienteId, periodo, compraId);
  }
}
