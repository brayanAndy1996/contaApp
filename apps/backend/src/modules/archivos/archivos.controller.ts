import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req, StreamableFile } from "@nestjs/common";
import type { PrevioArchivoDto, VersionArchivoDto } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { AccesoError } from "../acceso/errores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { ArchivosService } from "./archivos.service.js";

/** Permisos de la sesión (005 D5); sin acceso resuelto, la ruta no se atiende. */
function permisosDe(req: PeticionAcceso): ReadonlySet<string> {
  if (req.acceso === undefined) throw new AccesoError("permiso_denegado");
  return req.acceso.permisos;
}

/**
 * Archivos SIRE generados de COMPRAS (spec 012b, D1, D8, D9, P-4). Un controlador por libro con ruta literal: el libro sale de la
 * ruta, nunca del cuerpo. Previo, versiones y descarga piden `clientes.ver`; generar, `sire.aprobar_generar` (lo exige el servicio tras `ClienteScopeGuard`). El alcance lo exige
 * `ClienteScopeGuard` (ajeno, no asignado e inexistente dan el mismo 404). El periodo, el id y el cuerpo llegan crudos al servicio,
 * que los valida. Se registra en `ArchivosModule`, ANTES de `ComprasModule`: su `GET :compraId` capturaría `archivos`.
 */
@Controller("clientes/:clienteId/periodos/:periodo/compras/archivos")
export class ArchivosComprasController {
  constructor(@Inject(ArchivosService) private readonly servicio: ArchivosService) {}

  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Get("previo")
  previo(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<PrevioArchivoDto> {
    return this.servicio.previo(sesion, alcanceDe(req.acceso), clienteId, periodo, "compras");
  }

  /**
   * 202 `{ trabajoId }`: solo encola, nunca llama a SUNAT ni cambia el estado del periodo. El guard exige `clientes.ver` y el
   * servicio `sire.aprobar_generar` (403 `permiso_denegado`): así, quien no está asignado al cliente recibe el 404 de
   * `ClienteScopeGuard` antes de enterarse de qué permiso falta (como «Reabrir» de 014).
   */
  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Post()
  @HttpCode(202)
  generar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<{ trabajoId: string }> {
    return this.servicio.generar(sesion, alcanceDe(req.acceso), permisosDe(req), clienteId, periodo, "compras", cuerpo);
  }

  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Get()
  versiones(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<VersionArchivoDto[]> {
    return this.servicio.versiones(sesion, alcanceDe(req.acceso), clienteId, periodo, "compras");
  }

  /** El ZIP como ADJUNTO, `application/zip` y `nosniff`; solo si su SHA-256 es el guardado (si no, 500 `archivo_alterado`). */
  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Header("X-Content-Type-Options", "nosniff")
  @Get(":archivoId/zip")
  async descargar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("archivoId") archivoId: string,
  ): Promise<StreamableFile> {
    const { nombre, bytes } = await this.servicio.descargar(sesion, alcanceDe(req.acceso), clienteId, periodo, "compras", archivoId);
    return new StreamableFile(bytes, {
      type: "application/zip",
      disposition: `attachment; filename="${nombre}"`,
      length: bytes.length,
    });
  }
}

/** Archivos SIRE generados de VENTAS: las mismas cuatro rutas bajo `ventas/archivos` (ver `ArchivosComprasController`). */
@Controller("clientes/:clienteId/periodos/:periodo/ventas/archivos")
export class ArchivosVentasController {
  constructor(@Inject(ArchivosService) private readonly servicio: ArchivosService) {}

  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Get("previo")
  previo(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<PrevioArchivoDto> {
    return this.servicio.previo(sesion, alcanceDe(req.acceso), clienteId, periodo, "ventas");
  }

  /** Como en compras: el guard exige `clientes.ver` y el servicio `sire.aprobar_generar`. */
  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Post()
  @HttpCode(202)
  generar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Body() cuerpo: unknown,
  ): Promise<{ trabajoId: string }> {
    return this.servicio.generar(sesion, alcanceDe(req.acceso), permisosDe(req), clienteId, periodo, "ventas", cuerpo);
  }

  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Get()
  versiones(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
  ): Promise<VersionArchivoDto[]> {
    return this.servicio.versiones(sesion, alcanceDe(req.acceso), clienteId, periodo, "ventas");
  }

  @Permiso("clientes.ver")
  @Header("Cache-Control", "no-store")
  @Header("X-Content-Type-Options", "nosniff")
  @Get(":archivoId/zip")
  async descargar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("clienteId") clienteId: string,
    @Param("periodo") periodo: string,
    @Param("archivoId") archivoId: string,
  ): Promise<StreamableFile> {
    const { nombre, bytes } = await this.servicio.descargar(sesion, alcanceDe(req.acceso), clienteId, periodo, "ventas", archivoId);
    return new StreamableFile(bytes, {
      type: "application/zip",
      disposition: `attachment; filename="${nombre}"`,
      length: bytes.length,
    });
  }
}
