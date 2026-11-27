import { Controller, Get, Header, Inject, Query, Req } from "@nestjs/common";
import type { OpcionesAuditoria, PaginaAuditoria } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe } from "../clientes/contexto.js";
import { AuditoriaService } from "./auditoria.service.js";

/**
 * `GET /auditoria` (spec 017 P-2; 031 D-1 a D-6): Dueño y Administrador (`auditoria.ver`); el resto recibe 403 sin datos. El alcance sale
 * siempre del acceso resuelto de la sesión, nunca de la petición. `GET /auditoria/opciones` alimenta los selectores de la pantalla.
 */
@Controller("auditoria")
export class AuditoriaController {
  constructor(@Inject(AuditoriaService) private readonly servicio: AuditoriaService) {}

  @Permiso("auditoria.ver")
  @Get()
  @Header("Cache-Control", "no-store")
  listar(@Sesion() sesion: SesionResuelta, @Req() req: PeticionAcceso, @Query() query: unknown): Promise<PaginaAuditoria> {
    return this.servicio.listar(sesion, alcanceDe(req.acceso), query);
  }

  // Ruta literal distinta de `GET /auditoria`: no hay parámetros de ruta que la confundan.
  @Permiso("auditoria.ver")
  @Get("opciones")
  @Header("Cache-Control", "no-store")
  opciones(@Sesion() sesion: SesionResuelta, @Req() req: PeticionAcceso, @Query() query: unknown): Promise<OpcionesAuditoria> {
    return this.servicio.opciones(sesion, alcanceDe(req.acceso), query);
  }
}
