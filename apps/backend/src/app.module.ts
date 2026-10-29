import { Module, type DynamicModule } from "@nestjs/common";
import { NucleoModule, type DependenciasNucleo } from "./infra/nucleo.module.js";
import { AccesoModule } from "./modules/acceso/acceso.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { ClientesModule } from "./modules/clientes/clientes.module.js";
import { EstudioModule } from "./modules/estudio/estudio.module.js";
import type { OpcionesRedisTrabajos } from "./modules/trabajos/redis.js";
import { TrabajosModule } from "./modules/trabajos/trabajos.module.js";

/** Dependencias de la raíz: las del núcleo y el Redis de trabajos (008). */
export interface DependenciasApp extends DependenciasNucleo {
  redis: OpcionesRedisTrabajos;
}

/** Raíz de la app: `crearApp` aporta las dependencias (BD, hasher, cola de correo, comunes, origen, Redis). */
@Module({})
export class AppModule {
  static registrar({ redis, ...dependencias }: DependenciasApp): DynamicModule {
    return {
      module: AppModule,
      imports: [
        NucleoModule.registrar(dependencias),
        AuthModule,
        EstudioModule,
        AccesoModule,
        ClientesModule,
        TrabajosModule.registrar(redis),
      ],
    };
  }
}
