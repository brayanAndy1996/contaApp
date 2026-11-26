import { Module } from "@nestjs/common";
import { InvitacionesController } from "./invitaciones.controller.js";
import { InvitacionesService } from "./invitaciones.service.js";
import { RolesController } from "./roles/roles.controller.js";
import { RolesService } from "./roles/roles.service.js";
import { UsuariosController } from "./usuarios.controller.js";
import { UsuariosService } from "./usuarios.service.js";
import { YoController } from "./yo.controller.js";

/** Miembros, roles e invitaciones (spec 005) y roles propios (030). Las dependencias las aporta `NucleoModule` (global). */
@Module({
  controllers: [YoController, UsuariosController, InvitacionesController, RolesController],
  providers: [UsuariosService, InvitacionesService, RolesService],
})
export class AccesoModule {}
