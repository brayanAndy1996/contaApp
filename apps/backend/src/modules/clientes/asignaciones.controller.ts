import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import type { AsignacionListada } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso } from "../acceso/guards/decoradores.js";
import { AsignacionesService } from "./asignaciones.service.js";

/**
 * Asignación individual (`/clientes/:clienteId/asignaciones`) y masiva (`/asignaciones/por-*`). Todas exigen
 * `clientes.asignar`; las individuales además pasan por `ClienteScopeGuard`. El cuerpo llega crudo al servicio.
 */
@Controller()
export class AsignacionesController {
  constructor(@Inject(AsignacionesService) private readonly servicio: AsignacionesService) {}

  @Permiso("clientes.asignar")
  @Get("clientes/:clienteId/asignaciones")
  listar(@Sesion() sesion: SesionResuelta, @Param("clienteId") clienteId: string): Promise<AsignacionListada[]> {
    return this.servicio.listar(sesion, clienteId);
  }

  @Permiso("clientes.asignar")
  @Put("clientes/:clienteId/asignaciones/:usuarioId")
  asignar(
    @Sesion() sesion: SesionResuelta,
    @Param("clienteId") clienteId: string,
    @Param("usuarioId") usuarioId: string,
    @Body() cuerpo: unknown,
  ): Promise<AsignacionListada[]> {
    return this.servicio.asignar(sesion, clienteId, usuarioId, cuerpo);
  }

  @Permiso("clientes.asignar")
  @Delete("clientes/:clienteId/asignaciones/:usuarioId")
  @HttpCode(204)
  retirar(
    @Sesion() sesion: SesionResuelta,
    @Param("clienteId") clienteId: string,
    @Param("usuarioId") usuarioId: string,
  ): Promise<void> {
    return this.servicio.retirar(sesion, clienteId, usuarioId);
  }

  @Permiso("clientes.asignar")
  @Post("asignaciones/por-usuario")
  @HttpCode(200)
  porUsuario(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown): Promise<{ asignados: number }> {
    return this.servicio.porUsuario(sesion, cuerpo);
  }

  @Permiso("clientes.asignar")
  @Post("asignaciones/por-cliente")
  @HttpCode(200)
  porCliente(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown): Promise<{ asignados: number }> {
    return this.servicio.porCliente(sesion, cuerpo);
  }
}
