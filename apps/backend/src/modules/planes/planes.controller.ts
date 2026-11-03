import { Controller, Get } from "@nestjs/common";
import type { UsoPlanDto } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { SoloEstudio } from "../acceso/guards/decoradores.js";
import { PlanesService } from "./planes.service.js";

/** `GET /plan/uso`: plan, estado, límites y uso del estudio activo (D8, CA-2). */
@Controller("plan")
export class PlanesController {
  constructor(private readonly servicio: PlanesService) {}

  @Get("uso")
  @SoloEstudio()
  uso(@Sesion() s: SesionResuelta): Promise<UsoPlanDto> {
    return this.servicio.uso(s.tenantActivo as string, s.usuarioId);
  }
}
