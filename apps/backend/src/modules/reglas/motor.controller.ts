import { Body, Controller, Get, Header, HttpCode, Inject, Param, Put, Req } from "@nestjs/common";
import type { ReglasMotor } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { MotorReglasService } from "./motor.service.js";

/** Escribir los interruptores exige además un rol de alcance global (dueño o administrador): D-9. Sin él, 403. */
function exigirAlcanceGlobal(req: PeticionAcceso): void {
  if (req.acceso?.alcance !== "global") throw new AccesoError("permiso_denegado");
}

/**
 * Reglas del motor del estudio (spec 021, RF-089, P-8, P-10). `PUT aporte` es estático y va ANTES de `PUT :codigo`, o `:codigo`
 * lo capturaría. Un código fuera del catálogo da 404.
 */
@Controller("estudio/reglas-motor")
export class MotorReglasController {
  constructor(@Inject(MotorReglasService) private readonly servicio: MotorReglasService) {}

  @Permiso("reglas.ver")
  @Header("Cache-Control", "no-store")
  @Get()
  leer(@Sesion() sesion: SesionResuelta): Promise<ReglasMotor> {
    return this.servicio.leer(sesion);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Put("aporte")
  @HttpCode(200)
  aporte(@Sesion() sesion: SesionResuelta, @Req() req: PeticionAcceso, @Body() cuerpo: unknown): Promise<ReglasMotor> {
    exigirAlcanceGlobal(req);
    return this.servicio.fijarAporte(sesion, cuerpo);
  }

  @Permiso("reglas.gestionar")
  @Header("Cache-Control", "no-store")
  @Put(":codigo")
  @HttpCode(200)
  fijar(
    @Sesion() sesion: SesionResuelta,
    @Req() req: PeticionAcceso,
    @Param("codigo") codigo: string,
    @Body() cuerpo: unknown,
  ): Promise<ReglasMotor> {
    exigirAlcanceGlobal(req);
    return this.servicio.fijar(sesion, codigo, cuerpo);
  }
}
