import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Req } from "@nestjs/common";
import type { GastosEstudioVista } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { DiccionarioService } from "./diccionario.service.js";

/** Escribir el diccionario o el umbral del estudio exige además un rol de alcance global (dueño o administrador): D-3. Sin él, 403. */
function exigirAlcanceGlobal(req: PeticionAcceso): void {
  if (req.acceso?.alcance !== "global") throw new AccesoError("permiso_denegado");
}

/**
 * Gastos no deducibles del estudio (spec 027, RF-117; D-3): diccionario propio, globales desactivadas y umbral. Leer es `reglas.ver`;
 * escribir, `reglas.gestionar` Y alcance global (el Contador, con alcance asignado, recibe 403 antes de mirar el cuerpo o el recurso). El
 * estudio sale de la sesión. Todo `no-store`; los errores son `{ codigo }` sin eco. `umbral`, `palabras` y `globales` son rutas
 * estáticas de dos segmentos: no chocan con el `PUT :codigo` de las reglas del motor (21).
 */
@Controller("estudio/reglas-motor/gastos")
export class DiccionarioController {
  constructor(@Inject(DiccionarioService) private readonly servicio: DiccionarioService) {}

  @Permiso("reglas.ver")
  @Header("Cache-Control", "no-store")
  @Get()
  leer(@Sesion() sesion: SesionResuelta): Promise<GastosEstudioVista> {
    return this.servicio.leer(sesion);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Put("umbral")
  @HttpCode(200)
  umbral(@Sesion() sesion: SesionResuelta, @Req() req: PeticionAcceso, @Body() cuerpo: unknown): Promise<{ version: number }> {
    exigirAlcanceGlobal(req);
    return this.servicio.fijarUmbral(sesion, cuerpo);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Post("palabras")
  @HttpCode(201)
  agregar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Body() cuerpo: unknown,
  ): Promise<{ id: string; version: number }> {
    exigirAlcanceGlobal(req);
    return this.servicio.agregar(sesion, cuerpo);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Put("palabras/:id")
  @HttpCode(200)
  estadoPalabra(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("id") id: string,
    @Body() cuerpo: unknown,
  ): Promise<{ version: number }> {
    exigirAlcanceGlobal(req);
    return this.servicio.estadoPalabra(sesion, id, cuerpo);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Put("globales/:id")
  @HttpCode(200)
  estadoGlobal(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("id") id: string,
    @Body() cuerpo: unknown,
  ): Promise<Record<string, never>> {
    exigirAlcanceGlobal(req);
    return this.servicio.estadoGlobal(sesion, id, cuerpo);
  }
}
