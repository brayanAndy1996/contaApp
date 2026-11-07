import { Body, Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { Alcance } from "@contapp/db";
import type {
  AccionCompraRespuesta,
  CalcularRespuesta,
  DeshacerRespuesta,
  EstadoPeriodoRespuesta,
  InformeMasiva,
} from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { AccesoError } from "../acceso/errores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { AccionesComprasService } from "./acciones.service.js";
import { HistorialComprasService } from "./historial.service.js";
import { MasivasComprasService } from "./masivas.service.js";
import { PeriodoComprasService } from "./periodo.service.js";

/** `[alcance, permisos]` de la sesión (005 D5; D-9 de 014); sin acceso resuelto, la ruta no se atiende. */
export function accesoDe(req: PeticionAcceso): readonly [Alcance, ReadonlySet<string>] {
  if (req.acceso === undefined) throw new AccesoError("permiso_denegado");
  return [alcanceDe(req.acceso), req.acceso.permisos];
}

/**
 * Escrituras de compras de un cliente y periodo (spec 014, D-2, D-4 a D-7, D-9, D-11, D-14 a D-16, D-18). El permiso lo exige
 * `PermisoGuard` (`sire.clasificar`; reabrir `sire.aprobar_generar`) y el alcance, `ClienteScopeGuard` (`:clienteId`: ajeno,
 * no asignado e inexistente dan el mismo 404). El periodo y el cuerpo llegan crudos a los servicios, que los validan con los
 * esquemas de `@contapp/shared` (400 `solicitud_invalida`); el estado del periodo se comprueba antes que la versión base.
 *
 * Orden de rutas: las estáticas (`masivas/*`, `deshacer`, `rehacer`, `estado/*`) van antes de `:compraId/...`; si no,
 * `masivas/clasificar` se leería como la compra «masivas».
 */
@Controller("clientes/:clienteId/periodos/:periodo/compras")
export class ComprasAccionesController {
  constructor(
    @Inject(AccionesComprasService) private readonly acciones: AccionesComprasService,
    @Inject(MasivasComprasService) private readonly masivas: MasivasComprasService,
    @Inject(HistorialComprasService) private readonly historial: HistorialComprasService,
    @Inject(PeriodoComprasService) private readonly estado: PeriodoComprasService,
  ) {}

  @Permiso("sire.clasificar")
  @Post("masivas/clasificar")
  @HttpCode(200)
  masivaClasificar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<InformeMasiva> {
    return this.masivas.clasificar(sesion, ...accesoDe(req), clienteId, periodo, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post("masivas/aceptar")
  @HttpCode(200)
  masivaAceptar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<InformeMasiva> {
    return this.masivas.aceptar(sesion, ...accesoDe(req), clienteId, periodo, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post("masivas/excluir")
  @HttpCode(200)
  masivaExcluir(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<InformeMasiva> {
    return this.masivas.excluir(sesion, ...accesoDe(req), clienteId, periodo, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post("masivas/restaurar")
  @HttpCode(200)
  masivaRestaurar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<InformeMasiva> {
    return this.masivas.restaurar(sesion, ...accesoDe(req), clienteId, periodo, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post("deshacer")
  @HttpCode(200)
  deshacer(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<DeshacerRespuesta> {
    return this.historial.deshacer(sesion, ...accesoDe(req), clienteId, periodo);
  }

  @Permiso("sire.clasificar")
  @Post("rehacer")
  @HttpCode(200)
  rehacer(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<DeshacerRespuesta> {
    return this.historial.rehacer(sesion, ...accesoDe(req), clienteId, periodo);
  }

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
   * El guard exige `sire.clasificar` y el servicio `sire.aprobar_generar` (403 `permiso_denegado`): así, quien no está asignado
   * al cliente recibe el 404 de `ClienteScopeGuard` antes de enterarse de qué permiso falta.
   */
  @Permiso("sire.clasificar")
  @Post("estado/reabrir")
  @HttpCode(200)
  reabrir(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<EstadoPeriodoRespuesta> {
    return this.estado.reabrir(sesion, ...accesoDe(req), clienteId, periodo);
  }

  /** 201: la compra agregada a mano (D-7). */
  @Permiso("sire.clasificar")
  @Post()
  @HttpCode(201)
  agregar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    return this.acciones.agregar(sesion, ...accesoDe(req), clienteId, periodo, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post(":compraId/clasificar")
  @HttpCode(200)
  clasificar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
    @Body() cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    return this.acciones.clasificar(sesion, ...accesoDe(req), clienteId, periodo, compraId, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post(":compraId/editar")
  @HttpCode(200)
  editar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
    @Body() cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    return this.acciones.editar(sesion, ...accesoDe(req), clienteId, periodo, compraId, cuerpo);
  }

  /** D-16: sin escribir nada. */
  @Permiso("sire.clasificar")
  @Post(":compraId/calcular")
  @HttpCode(200)
  calcular(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
    @Body() cuerpo: unknown,
  ): Promise<CalcularRespuesta> {
    return this.acciones.calcular(sesion, ...accesoDe(req), clienteId, periodo, compraId, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post(":compraId/sugerencias/aceptar")
  @HttpCode(200)
  aceptarSugerencia(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
    @Body() cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    return this.acciones.aceptarSugerencia(sesion, ...accesoDe(req), clienteId, periodo, compraId, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post(":compraId/excluir")
  @HttpCode(200)
  excluir(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
    @Body() cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    return this.acciones.excluir(sesion, ...accesoDe(req), clienteId, periodo, compraId, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post(":compraId/restaurar")
  @HttpCode(200)
  restaurar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
    @Body() cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    return this.acciones.restaurar(sesion, ...accesoDe(req), clienteId, periodo, compraId, cuerpo);
  }

  @Permiso("sire.clasificar")
  @Post(":compraId/descartar")
  @HttpCode(200)
  descartar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
    @Body() cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    return this.acciones.descartar(sesion, ...accesoDe(req), clienteId, periodo, compraId, cuerpo);
  }
}
