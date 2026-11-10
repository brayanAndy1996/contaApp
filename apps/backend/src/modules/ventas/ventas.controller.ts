import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { reabrirPeriodoSchema } from "@contapp/shared";
import type {
  CorrelatividadVentasDto,
  DiferenciaVentasDto,
  EstadoPeriodoRespuesta,
  PaginaVentasDto,
  PropuestaVentasDto,
  ResumenVentasVista,
  SaltoJustificadoDto,
  VentaDto,
  VistaPreviaVentas,
} from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { AccesoError } from "../acceso/errores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { accesoDe } from "./apoyo.js";
import { EstadoVentasService } from "./estado.service.js";
import { ExclusionVentasService } from "./exclusion.service.js";
import { ImportarPropuestaService } from "./importar-propuesta.service.js";
import { VentasService } from "./ventas.service.js";

/**
 * Ventas de un cliente y periodo (spec 013, D2, D5 a D11). El permiso lo exige `PermisoGuard` (leer: `clientes.ver`;
 * descargar: `sire.descargar`; agregar, quitar, justificar, revertir, excluir, restaurar y marcar revisado: `sire.clasificar`;
 * reabrir: `sire.clasificar` en el guard y `sire.aprobar_generar` en el servicio, como en compras) y el alcance, `ClienteScopeGuard`
 * (`:clienteId`: ajeno, no asignado e inexistente dan el mismo 404). El periodo, el cuerpo y la query llegan crudos al
 * servicio, que los valida (400 `solicitud_invalida`). La importación del layout provisional (`sire.descargar`) recibe el
 * archivo crudo (`application/octet-stream`, ≤ 8 MB, analizado en `crearApp`): llega como `Buffer` y nada de él se registra.
 * Spec 012b: las escrituras (descargar, importar, agregar, quitar, justificar, revertir, excluir y restaurar) respetan el estado del
 * periodo de ventas (409 `periodo_generado`; con `revisado`, 403 `periodo_revisado` sin `sire.aprobar_generar`, P-9).
 */
@Controller("clientes/:clienteId/periodos/:periodo/ventas")
export class VentasController {
  constructor(
    @Inject(VentasService) private readonly servicio: VentasService,
    @Inject(ImportarPropuestaService) private readonly importacion: ImportarPropuestaService,
    @Inject(EstadoVentasService) private readonly estado: EstadoVentasService,
    @Inject(ExclusionVentasService) private readonly exclusion: ExclusionVentasService,
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
    return this.servicio.descargar(sesion, ...accesoDe(req), clienteId, periodo);
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
  ): Promise<ResumenVentasVista> {
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

  /** 200 `{ filas, validas, conError }`: errores por fila, sin escribir nada. */
  @Permiso("sire.descargar")
  @Post("importar/vista-previa")
  @HttpCode(200)
  vistaPrevia(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<VistaPreviaVentas> {
    return this.importacion.vistaPrevia(sesion, alcanceDe(req.acceso), clienteId, periodo, cuerpo);
  }

  /** 201 `{ propuesta }`: revalida todo y complementa el periodo; con una fila con error no guarda nada. */
  @Permiso("sire.descargar")
  @Post("importar/confirmar")
  @HttpCode(201)
  confirmarImportacion(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<{ propuesta: PropuestaVentasDto }> {
    return this.importacion.confirmar(sesion, ...accesoDe(req), clienteId, periodo, cuerpo);
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
    return this.servicio.agregar(sesion, ...accesoDe(req), clienteId, periodo, cuerpo);
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
    return this.servicio.justificar(sesion, ...accesoDe(req), clienteId, periodo, cuerpo);
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
    return this.servicio.revertir(sesion, ...accesoDe(req), clienteId, periodo, justificacionId);
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
    return this.servicio.quitar(sesion, ...accesoDe(req), clienteId, periodo, ventaId);
  }

  /** 200 `{ estado: "revisado", por, en }` (P-1, como 014): solo desde `abierto`; 409 `estado_invalido` si ya no lo es. */
  @Permiso("sire.clasificar")
  @Post("estado/revisar")
  @HttpCode(200)
  revisar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<EstadoPeriodoRespuesta> {
    return this.estado.revisar(sesion, accesoDe(req)[0], clienteId, periodo);
  }

  /**
   * 200 `{ estado: "abierto", por, en }`. El guard exige `sire.clasificar` y el servicio `sire.aprobar_generar` (403
   * `permiso_denegado`): así, quien no está asignado al cliente recibe el 404 de `ClienteScopeGuard` antes de enterarse de qué
   * permiso falta. `estadoVisto` es el estado que vio quien reabre (`revisado` o `generado`); otro valor es 400.
   */
  @Permiso("sire.clasificar")
  @Post("estado/reabrir")
  @HttpCode(200)
  reabrir(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<EstadoPeriodoRespuesta> {
    const v = reabrirPeriodoSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.estado.reabrir(sesion, ...accesoDe(req), clienteId, periodo, v.data.estadoVisto);
  }

  /** 200 `VentaDto` con su `exclusion` (D12, P-8): solo una venta del SIRE con error de su fila; el motivo es de 1 a 200 caracteres. */
  @Permiso("sire.clasificar")
  @Post(":ventaId/excluir")
  @HttpCode(200)
  excluir(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("ventaId") ventaId: string,
    @Body() cuerpo: unknown,
  ): Promise<VentaDto> {
    return this.exclusion.excluir(sesion, ...accesoDe(req), clienteId, periodo, ventaId, cuerpo);
  }

  /** 200 `VentaDto` con `exclusion: null`: cierra la exclusión vigente (nada se borra); cuerpo vacío y estricto. */
  @Permiso("sire.clasificar")
  @Post(":ventaId/restaurar")
  @HttpCode(200)
  restaurar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("ventaId") ventaId: string,
    @Body() cuerpo: unknown,
  ): Promise<VentaDto> {
    return this.exclusion.restaurar(sesion, ...accesoDe(req), clienteId, periodo, ventaId, cuerpo);
  }
}
