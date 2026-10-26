import { Module, type DynamicModule } from "@nestjs/common";
import { NucleoModule, type DependenciasNucleo } from "./infra/nucleo.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { EstudioModule } from "./modules/estudio/estudio.module.js";

/** Raíz de la app: `crearApp` aporta las dependencias (BD, hasher, cola de correo, comunes, origen). */
@Module({})
export class AppModule {
  static registrar(dependencias: DependenciasNucleo): DynamicModule {
    return {
      module: AppModule,
      imports: [NucleoModule.registrar(dependencias), AuthModule, EstudioModule],
    };
  }
}
