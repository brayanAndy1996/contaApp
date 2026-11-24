import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Req } from "@nestjs/common";
import type { AprenderRespuesta, CategoriasClienteVista, PropuestaAprenderVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { AprenderService } from "./aprender.service.js";
import { ClienteGastosService } from "./cliente.service.js";
import { ReevaluarGastosService } from "./reevaluar.service.js";

/**
 * Gastos no deducibles del cliente (spec 027, D-3): categorías permitidas, «Aprender estas palabras» y «Volver a evaluar». El permiso lo
 * exige `PermisoGuard` (`reglas.ver` para leer, `reglas.gestionar` para ajustar y aprender, `sire.clasificar` para volver a evaluar: quien no
 * lo tiene recibe 403 antes de mirar el cliente) y el alcance, `ClienteScopeGuard` (`:clienteId`: ajeno, no asignado e inexistente dan el
 * mismo 404). Query y cuerpo llegan crudos al servicio, que los valida con `@contapp/shared` (400 `solicitud_invalida`). Todo `no-store`.
 */
@Controller("clientes/:clienteId")
export class ClienteGastosController {
  constructor(
    @Inject(ClienteGastosService) private readonly categorias: ClienteGastosService,
    @Inject(AprenderService) private readonly aprender: AprenderService,
    @Inject(ReevaluarGastosService) private readonly reevaluar: ReevaluarGastosService,
  ) {}

  @Permiso("reglas.ver")
  @Header("Cache-Control", "no-store")
  @Get("gastos/categorias")
  leerCategorias(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
  ): Promise<CategoriasClienteVista> {
    return this.categorias.leer(sesion, alcanceDe(req.acceso), clienteId);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Put("gastos/categorias")
  @HttpCode(200)
  guardarCategorias(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Body() cuerpo: unknown,
  ): Promise<{ version: number }> {
    return this.categorias.guardar(sesion, alcanceDe(req.acceso), clienteId, cuerpo);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Get("periodos/:periodo/gastos/aprender/:compraId")
  proponer(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
  ): Promise<PropuestaAprenderVista> {
    return this.aprender.proponer(sesion, alcanceDe(req.acceso), clienteId, periodo, compraId);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Post("periodos/:periodo/gastos/aprender/:compraId")
  @HttpCode(200)
  guardarAprendidas(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("compraId") compraId: string,
    @Body() cuerpo: unknown,
  ): Promise<AprenderRespuesta> {
    return this.aprender.aprender(sesion, alcanceDe(req.acceso), clienteId, periodo, compraId, cuerpo);
  }

  /** 202 `{ trabajoId }`: el del trabajo nuevo o el del vivo del mismo cliente y periodo (dedupe de 008). Solo encola: no evalúa. */
  @Permiso("sire.clasificar")
  @Header("Cache-Control", "no-store")
  @Post("periodos/:periodo/gastos/reevaluar")
  @HttpCode(202)
  volverAEvaluar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<{ trabajoId: string }> {
    return this.reevaluar.reevaluar(sesion, alcanceDe(req.acceso), clienteId, periodo, cuerpo);
  }
}
