import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import type { CredencialEstadoDto, GuardarCredencialRespuesta, TrabajoVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso } from "../acceso/guards/decoradores.js";
import { CredencialesService } from "./credenciales.service.js";

/**
 * Credenciales de un cliente (spec 007b, D3–D6). Permiso por `PermisoGuard`, alcance por `ClienteScopeGuard`
 * (`:clienteId`). El cuerpo llega crudo al servicio, que lo valida: nada de él se registra ni se devuelve.
 */
@Controller("clientes/:clienteId/credenciales")
export class CredencialesController {
  constructor(@Inject(CredencialesService) private readonly servicio: CredencialesService) {}

  @Permiso("credenciales.editar")
  @Put(":tipo")
  @HttpCode(200)
  guardar(
    @Sesion() sesion: SesionResuelta,
    @Param("clienteId") clienteId: string,
    @Param("tipo") tipo: string,
    @Body() cuerpo: unknown,
  ): Promise<GuardarCredencialRespuesta> {
    return this.servicio.guardar(sesion, clienteId, tipo, cuerpo);
  }

  @Permiso("clientes.ver")
  @Get()
  estado(@Sesion() sesion: SesionResuelta, @Param("clienteId") clienteId: string): Promise<CredencialEstadoDto[]> {
    return this.servicio.estado(sesion, clienteId);
  }

  @Permiso("credenciales.editar")
  @Post(":tipo/verificar")
  @HttpCode(202)
  verificar(
    @Sesion() sesion: SesionResuelta,
    @Param("clienteId") clienteId: string,
    @Param("tipo") tipo: string,
  ): Promise<TrabajoVista> {
    return this.servicio.verificar(sesion, clienteId, tipo);
  }
}
