import { Body, Controller, Get, Header, HttpCode, Inject, Post, Query, Req } from "@nestjs/common";
import type { RespuestaBandeja, RespuestaLote } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { AtencionBuzonService } from "./atencion.service.js";
import { BandejaBuzonService } from "./bandeja.service.js";

/**
 * Bandeja de buzones y atención en lote (spec 024). Rutas sin `:clienteId`: el permiso lo exige `PermisoGuard` y el alcance lo
 * aplica cada servicio con `filtroAlcance` dentro de la transacción (un cliente o mensaje ajeno, no asignado o inexistente da el
 * mismo 404). Query y cuerpo llegan crudos y se validan con `@contapp/shared` (400 `solicitud_invalida`). Todo `no-store`.
 */
@Controller("buzon")
export class BandejaController {
  constructor(
    @Inject(BandejaBuzonService) private readonly bandeja: BandejaBuzonService,
    @Inject(AtencionBuzonService) private readonly atencion: AtencionBuzonService,
  ) {}

  /** 200 `{ mensajes, siguiente }` · 400 `solicitud_invalida` | `cursor_invalido`. */
  @Permiso("buzon.ver")
  @Header("Cache-Control", "no-store")
  @Get("mensajes")
  listar(@Sesion() sesion: SesionResuelta, @Req() req: PeticionAcceso, @Query() query: unknown): Promise<RespuestaBandeja> {
    return this.bandeja.listar(sesion, alcanceDe(req.acceso), query);
  }

  /** Marcar varios como atendidos (solo marcar, U-3): 200 `{ atendidos, omitidos }`. */
  @Permiso("buzon.atender")
  @Header("Cache-Control", "no-store")
  @Post("atencion")
  @HttpCode(200)
  atenderLote(@Sesion() sesion: SesionResuelta, @Req() req: PeticionAcceso, @Body() cuerpo: unknown): Promise<RespuestaLote> {
    return this.atencion.atenderLote(sesion, alcanceDe(req.acceso), cuerpo);
  }
}
