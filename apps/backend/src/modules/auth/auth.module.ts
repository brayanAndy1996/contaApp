import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { RecuperacionService } from "./recuperacion.service.js";
import { SesionesService } from "./totp/sesiones.service.js";
import { TotpController } from "./totp/totp.controller.js";
import { TotpService } from "./totp/totp.service.js";

// Las dependencias (DB, HASHER, COLA_CORREO, COMUNES, APP_ORIGIN, TOTP_CLAVES) las aporta `NucleoModule` (global).
@Module({
  controllers: [AuthController, TotpController],
  providers: [AuthService, RecuperacionService, TotpService, SesionesService],
  exports: [AuthService],
})
export class AuthModule {}
