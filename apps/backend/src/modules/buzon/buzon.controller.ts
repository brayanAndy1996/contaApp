import { Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import type { AbrirMensajeRespuesta, DetalleMensaje, PaginaMensajesBuzon, RevisarBuzonRespuesta } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { disposicionAdjunta, mimeSeguro } from "./apoyo.js";
import { BuzonError } from "./errores.js";
import { LecturaBuzonService } from "./lectura.service.js";
import { SolicitudBuzonService } from "./solicitud.service.js";

/** Lo mínimo de la respuesta de Express que usan estas rutas (el 200 de un trabajo vivo y `Retry-After`). */
interface RespuestaHttp {
  status(codigo: number): unknown;
  setHeader(nombre: string, valor: string): unknown;
}

/**
 * Buzón SOL del cliente (spec 023, D-6, D-8). El permiso lo exige `PermisoGuard` (`buzon.ver`; abrir, `buzon.marcar_leido`) y el
 * alcance `ClienteScopeGuard` (`:clienteId`: ajeno, no asignado e inexistente dan el mismo 404). Query y cuerpo llegan crudos al
 * servicio: el cuerpo se ignora y la query se valida con `@contapp/shared` (400 `solicitud_invalida`). Todo `no-store`.
 */
@Controller("clientes/:clienteId/buzon")
export class BuzonController {
  constructor(
    @Inject(SolicitudBuzonService) private readonly solicitud: SolicitudBuzonService,
    @Inject(LecturaBuzonService) private readonly lectura: LecturaBuzonService,
  ) {}

  /** 202 `{ trabajo }` nuevo · 200 con el vivo · 409 · 429 `captura_reciente` con `Retry-After`. Solo encola: no llama a SUNAT. */
  @Permiso("buzon.ver")
  @Header("Cache-Control", "no-store")
  @Post("revisar")
  @HttpCode(202)
  async revisar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Res({ passthrough: true }) res: RespuestaHttp,
  ): Promise<RevisarBuzonRespuesta> {
    try {
      const r = await this.solicitud.revisar(sesion, alcanceDe(req.acceso), clienteId);
      if (!r.nuevo) res.status(200);
      return { trabajo: r.trabajo };
    } catch (e) {
      if (e instanceof BuzonError && e.reintentarEnSeg !== undefined) res.setHeader("Retry-After", String(e.reintentarEnSeg));
      throw e;
    }
  }

  @Permiso("buzon.ver")
  @Header("Cache-Control", "no-store")
  @Get("mensajes")
  listar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Query() query: unknown,
  ): Promise<PaginaMensajesBuzon> {
    return this.lectura.listar(sesion, alcanceDe(req.acceso), clienteId, query);
  }

  @Permiso("buzon.ver")
  @Header("Cache-Control", "no-store")
  @Get("mensajes/:mensajeId")
  detalle(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("mensajeId") mensajeId: string,
  ): Promise<DetalleMensaje> {
    return this.lectura.detalle(sesion, alcanceDe(req.acceso), clienteId, mensajeId);
  }

  /** 202 `{ trabajo }` nuevo · 200 `{ trabajo }` vivo · 200 `{ trabajo: null }` si el contenido ya se obtuvo. */
  @Permiso("buzon.marcar_leido")
  @Header("Cache-Control", "no-store")
  @Post("mensajes/:mensajeId/abrir")
  @HttpCode(202)
  async abrir(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("mensajeId") mensajeId: string,
    @Res({ passthrough: true }) res: RespuestaHttp,
  ): Promise<AbrirMensajeRespuesta> {
    const r = await this.solicitud.abrir(sesion, alcanceDe(req.acceso), clienteId, mensajeId);
    if (!r.nuevo) res.status(200);
    return { trabajo: r.trabajo };
  }

  /** El adjunto como ATTACHMENT, con el MIME de la fila y `nosniff`: un HTML o SVG guardado jamás se interpreta en el navegador. */
  @Permiso("buzon.ver")
  @Header("Cache-Control", "no-store")
  @Header("X-Content-Type-Options", "nosniff")
  @Get("mensajes/:mensajeId/adjuntos/:adjuntoId")
  async descargar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("mensajeId") mensajeId: string,
    @Param("adjuntoId") adjuntoId: string,
  ): Promise<StreamableFile> {
    const a = await this.lectura.descargar(sesion, alcanceDe(req.acceso), clienteId, mensajeId, adjuntoId);
    return new StreamableFile(a.bytes, {
      type: mimeSeguro(a.mime),
      disposition: disposicionAdjunta(a.nombre),
      length: a.bytes.length,
    });
  }
}
