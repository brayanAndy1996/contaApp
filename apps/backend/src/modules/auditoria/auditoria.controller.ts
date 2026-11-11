import { Controller, Get, Header, Inject, Query } from "@nestjs/common";
import type { PaginaAuditoria } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso } from "../acceso/guards/decoradores.js";
import { AuditoriaService } from "./auditoria.service.js";

/** `GET /auditoria?cursor=` (spec 017, P-2): Dueño y Administrador (`auditoria.ver`); el resto recibe 403 sin datos. */
@Controller("auditoria")
export class AuditoriaController {
  constructor(@Inject(AuditoriaService) private readonly servicio: AuditoriaService) {}

  @Permiso("auditoria.ver")
  @Get()
  @Header("Cache-Control", "no-store")
  listar(@Sesion() sesion: SesionResuelta, @Query() query: unknown): Promise<PaginaAuditoria> {
    return this.servicio.listar(sesion, query);
  }
}
