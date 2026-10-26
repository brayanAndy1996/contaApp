import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { RecuperacionService } from "./recuperacion.service.js";

// Las dependencias (DB, HASHER, COLA_CORREO, COMUNES, APP_ORIGIN) las aporta `NucleoModule` (global).
@Module({
  controllers: [AuthController],
  providers: [AuthService, RecuperacionService],
  exports: [AuthService],
})
export class AuthModule {}
