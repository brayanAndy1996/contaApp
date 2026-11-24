import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { HistorialMesVista, ProrrataVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { EscrituraProrrataService } from "./escritura.service.js";
import { LecturaProrrataService } from "./lectura.service.js";
import { ObtencionProrrataService } from "./obtencion.service.js";

/**
 * Prorrata e IGV estimado del cliente (spec 026, D-5). El permiso lo exige `PermisoGuard` (`prorrata.ver` para leer,
 * `prorrata.gestionar` para obtener y guardar: quien no lo tiene recibe 403 antes de mirar el cliente) y el alcance,
 * `ClienteScopeGuard` (`:clienteId`: ajeno, no asignado e inexistente dan el mismo 404). Query y cuerpo llegan crudos al servicio, que
 * los valida con `@contapp/shared` (400 `solicitud_invalida`). Todo `no-store`. Las rutas estáticas (`declaraciones`, `usada`) no chocan
 * con `meses/:periodo`.
 */
@Controller("clientes/:clienteId/prorrata")
export class ProrrataController {
  constructor(
    @Inject(LecturaProrrataService) private readonly lectura: LecturaProrrataService,
    @Inject(ObtencionProrrataService) private readonly obtencion: ObtencionProrrataService,
    @Inject(EscrituraProrrataService) private readonly escritura: EscrituraProrrataService,
  ) {}

  /** 200 `ProrrataVista`; sin `periodo`, el mes anterior en hora de Lima; 400 `periodo_futuro`. */
  @Permiso("prorrata.ver")
  @Header("Cache-Control", "no-store")
  @Get()
  ver(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Query("periodo") periodo: unknown,
  ): Promise<ProrrataVista> {
    return this.lectura.vista(sesion, alcanceDe(req.acceso), clienteId, periodo);
  }

  @Permiso("prorrata.ver")
  @Header("Cache-Control", "no-store")
  @Get("meses/:periodo/historial")
  historial(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<HistorialMesVista> {
    return this.lectura.historial(sesion, alcanceDe(req.acceso), clienteId, periodo);
  }

  /** 202 `{ trabajoId }`: el del trabajo nuevo o el del vivo del mismo cliente y periodo (dedupe de 008). Solo encola: no llama a SOL. */
  @Permiso("prorrata.gestionar")
  @Header("Cache-Control", "no-store")
  @Post("declaraciones")
  @HttpCode(202)
  obtener(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Body() cuerpo: unknown,
  ): Promise<{ trabajoId: string }> {
    return this.obtencion.obtener(sesion, alcanceDe(req.acceso), clienteId, cuerpo);
  }

  @Permiso("prorrata.gestionar")
  @Header("Cache-Control", "no-store")
  @Put("meses/:periodo")
  @HttpCode(200)
  guardarMes(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<{ version: number }> {
    return this.escritura.guardarMes(sesion, alcanceDe(req.acceso), clienteId, periodo, cuerpo);
  }

  @Permiso("prorrata.gestionar")
  @Header("Cache-Control", "no-store")
  @Post("meses/:periodo/eliminar")
  @HttpCode(200)
  eliminarMes(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<{ version: number }> {
    return this.escritura.eliminarMes(sesion, alcanceDe(req.acceso), clienteId, periodo, cuerpo);
  }

  @Permiso("prorrata.gestionar")
  @Header("Cache-Control", "no-store")
  @Put("usada/:periodo")
  @HttpCode(200)
  guardarUsada(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<{ version: number }> {
    return this.escritura.guardarUsada(sesion, alcanceDe(req.acceso), clienteId, periodo, cuerpo);
  }
}
