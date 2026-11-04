import { Module } from "@nestjs/common";
import { CredencialesController } from "./credenciales.controller.js";
import { CredencialesService } from "./credenciales.service.js";
import { KEY_WRAPPER, keyWrapperPerezoso } from "./key-wrapper.js";

/** Credenciales de solo escritura, estado y verificación (spec 007b, D3–D6). El `Encolador` llega del módulo global. */
@Module({
  controllers: [CredencialesController],
  providers: [{ provide: KEY_WRAPPER, useFactory: () => keyWrapperPerezoso(process.env) }, CredencialesService],
  exports: [CredencialesService],
})
export class CredencialesModule {}
