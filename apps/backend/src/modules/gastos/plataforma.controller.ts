import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import type { DiccionarioGlobalVista, HistorialGlobalVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion, SinEstudio } from "../auth/guards/decoradores.js";
import { SoloPlataforma } from "../acceso/guards/decoradores.js";
import { DiccionarioPlataformaService } from "./plataforma.service.js";

/**
 * Diccionario global de gastos no deducibles (spec 027, RF-117, U-2): solo el super-admin. Todas las rutas son `@SinEstudio` +
 * `@SoloPlataforma` (sesión viva, sin estudio; el alta en `admin_plataforma` la revalidan las funciones SQL en cada llamada); un usuario
 * de estudio recibe 403. `historial` es estática y va ANTES de `:id`. Todo `no-store`.
 */
@Controller("plataforma/diccionario")
@SinEstudio()
@SoloPlataforma()
export class DiccionarioPlataformaController {
  constructor(@Inject(DiccionarioPlataformaService) private readonly servicio: DiccionarioPlataformaService) {}

  @Header("Cache-Control", "no-store")
  @Get()
  listar(@Sesion() s: SesionResuelta): Promise<DiccionarioGlobalVista> {
    return this.servicio.listar(s);
  }

  @Header("Cache-Control", "no-store")
  @Get("historial")
  historial(
    @Sesion() s: SesionResuelta,
    @Query("limite") limite: unknown,
    @Query("antes") antes: unknown,
  ): Promise<HistorialGlobalVista> {
    return this.servicio.historial(s, limite, antes);
  }

  @Header("Cache-Control", "no-store")
  @Post()
  @HttpCode(201)
  agregar(@Sesion() s: SesionResuelta, @Body() cuerpo: unknown) {
    return this.servicio.agregar(s, cuerpo);
  }

  @Header("Cache-Control", "no-store")
  @Put(":id")
  @HttpCode(200)
  editar(@Sesion() s: SesionResuelta, @Param("id") id: string, @Body() cuerpo: unknown) {
    return this.servicio.editar(s, id, cuerpo);
  }
}
