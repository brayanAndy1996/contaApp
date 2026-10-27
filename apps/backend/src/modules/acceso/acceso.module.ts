import { Module } from "@nestjs/common";
import { InvitacionesController } from "./invitaciones.controller.js";
import { InvitacionesService } from "./invitaciones.service.js";
import { UsuariosController } from "./usuarios.controller.js";
import { UsuariosService } from "./usuarios.service.js";
import { YoController } from "./yo.controller.js";

/** Miembros, roles e invitaciones (spec 005). Las dependencias las aporta `NucleoModule` (global). */
@Module({
  controllers: [YoController, UsuariosController, InvitacionesController],
  providers: [UsuariosService, InvitacionesService],
})
export class AccesoModule {}
