import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import type { PlanDto } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion, SinEstudio } from "../auth/guards/decoradores.js";
import { SoloPlataforma } from "../acceso/guards/decoradores.js";
import {
  PlataformaService,
  type EstudioDto,
  type SuscripcionDto,
} from "./plataforma.service.js";

/**
 * Administración de la plataforma (spec 006, D5, D13). Todas las rutas: `@SinEstudio` + `@SoloPlataforma` (sesión
 * viva, sin estudio; el alta en `admin_plataforma` la revalidan las funciones SQL). Un no-admin recibe 403.
 */
@Controller("plataforma")
@SinEstudio()
@SoloPlataforma()
export class PlataformaController {
  constructor(
    @Inject(PlataformaService) private readonly servicio: PlataformaService,
  ) {}

  @Get("yo")
  yo(@Sesion() s: SesionResuelta): Promise<{ admin: true }> {
    return this.servicio.yo(s);
  }

  @Get("planes")
  planes(@Sesion() s: SesionResuelta): Promise<PlanDto[]> {
    return this.servicio.listarPlanes(s);
  }

  @Post("planes")
  crear(
    @Sesion() s: SesionResuelta,
    @Body() cuerpo: unknown,
  ): Promise<PlanDto> {
    return this.servicio.crearPlan(s, cuerpo);
  }

  @Put("planes/:planId")
  @HttpCode(200)
  editar(
    @Sesion() s: SesionResuelta,
    @Param("planId") planId: string,
    @Body() cuerpo: unknown,
  ): Promise<PlanDto> {
    return this.servicio.editarPlan(s, planId, cuerpo);
  }

  @Get("estudios")
  estudios(@Sesion() s: SesionResuelta): Promise<EstudioDto[]> {
    return this.servicio.listarEstudios(s);
  }

  @Put("estudios/:tenantId/suscripcion")
  @HttpCode(200)
  asignar(
    @Sesion() s: SesionResuelta,
    @Param("tenantId") tenantId: string,
    @Body() cuerpo: unknown,
  ): Promise<SuscripcionDto> {
    return this.servicio.asignarSuscripcion(s, tenantId, cuerpo);
  }
}
