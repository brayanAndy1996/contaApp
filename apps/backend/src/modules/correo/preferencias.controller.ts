import { Body, Controller, Get, Header, HttpCode, Inject, Put } from "@nestjs/common";
import type { PreferenciasCorreoVista } from "@contapp/shared";
import { SoloEstudio } from "../acceso/guards/decoradores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { PreferenciasService } from "./preferencias.service.js";

/**
 * «Mi cuenta → Correo» (spec 028, R-10, R-15). `@SoloEstudio`: cualquier miembro activo ve y cambia SUS preferencias; el rol y las
 * asignaciones los decide la función de BD. Toda respuesta lleva `Cache-Control: no-store`.
 */
@Controller("cuenta/correo")
export class PreferenciasController {
  constructor(@Inject(PreferenciasService) private readonly servicio: PreferenciasService) {}

  @SoloEstudio()
  @Get()
  @Header("Cache-Control", "no-store")
  leer(@Sesion() sesion: SesionResuelta): Promise<PreferenciasCorreoVista> {
    return this.servicio.leer(sesion);
  }

  @SoloEstudio()
  @Put()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  guardar(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown): Promise<PreferenciasCorreoVista> {
    return this.servicio.guardar(sesion, cuerpo);
  }
}
