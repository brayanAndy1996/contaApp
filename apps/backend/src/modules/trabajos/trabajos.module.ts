import { Module, type DynamicModule } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NOTIFICADOR, NotificadorRedis } from "../notificaciones/notificador.js";
import { Encolador } from "./encolador.js";
import {
  OPCIONES_REDIS,
  RedisTrabajos,
  type OpcionesRedisTrabajos,
} from "./redis.js";
import { StreamService } from "./stream.service.js";
import { TrabajosController } from "./trabajos.controller.js";
import { TrabajosService } from "./trabajos.service.js";

/** Lista, SSE y cancelación de trabajos, y el `Encolador` que usan 007 y siguientes (spec 008, T11). */
@Module({})
export class TrabajosModule {
  static registrar(redis: OpcionesRedisTrabajos): DynamicModule {
    return {
      module: TrabajosModule,
      // Global: 007b (credenciales, importación, clientes) inyecta el `Encolador` sin conocer la config de Redis.
      global: true,
      imports: [AuthModule],
      controllers: [TrabajosController],
      providers: [
        { provide: OPCIONES_REDIS, useValue: redis },
        RedisTrabajos,
        TrabajosService,
        StreamService,
        Encolador,
        // Spec 017: aviso en vivo de notificaciones nuevas (comparte la conexión Redis de este módulo).
        { provide: NOTIFICADOR, useClass: NotificadorRedis },
      ],
      exports: [Encolador, NOTIFICADOR],
    };
  }
}
