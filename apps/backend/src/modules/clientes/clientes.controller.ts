import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { ClienteDto } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { ClientesService } from "./clientes.service.js";
import { alcanceDe } from "./contexto.js";

/**
 * Clientes (spec 007a, D3). El permiso lo exige `PermisoGuard`; las rutas con `:clienteId` pasan además por
 * `ClienteScopeGuard` (inexistente, ajeno y no asignado dan el mismo 404) y el listado por `filtroAlcance`.
 * El cuerpo y la query llegan crudos al servicio, que los valida (400 `solicitud_invalida`).
 */
@Controller("clientes")
export class ClientesController {
  constructor(@Inject(ClientesService) private readonly servicio: ClientesService) {}

  @Permiso("clientes.crear")
  @Post()
  crear(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown): Promise<ClienteDto> {
    return this.servicio.crear(sesion, cuerpo);
  }

  @Permiso("clientes.ver")
  @Get()
  listar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Query() query: unknown,
  ): Promise<ClienteDto[]> {
    return this.servicio.listar(sesion, alcanceDe(req.acceso), query);
  }

  @Permiso("clientes.ver")
  @Get(":clienteId")
  leer(@Sesion() sesion: SesionResuelta, @Param("clienteId") clienteId: string): Promise<ClienteDto> {
    return this.servicio.leer(sesion, clienteId);
  }

  @Permiso("clientes.editar")
  @Patch(":clienteId")
  editar(
    @Sesion() sesion: SesionResuelta,
    @Param("clienteId") clienteId: string,
    @Body() cuerpo: unknown,
  ): Promise<ClienteDto> {
    return this.servicio.editar(sesion, clienteId, cuerpo);
  }

  @Permiso("clientes.archivar")
  @Post(":clienteId/archivar")
  @HttpCode(200)
  archivar(@Sesion() sesion: SesionResuelta, @Param("clienteId") clienteId: string): Promise<ClienteDto> {
    return this.servicio.archivar(sesion, clienteId);
  }

  @Permiso("clientes.archivar")
  @Post(":clienteId/reactivar")
  @HttpCode(200)
  reactivar(@Sesion() sesion: SesionResuelta, @Param("clienteId") clienteId: string): Promise<ClienteDto> {
    return this.servicio.reactivar(sesion, clienteId);
  }
}
