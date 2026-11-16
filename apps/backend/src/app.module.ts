import { Module, type DynamicModule } from "@nestjs/common";
import type { StorageProvider } from "@contapp/storage";
import { NucleoModule, type DependenciasNucleo } from "./infra/nucleo.module.js";
import { AccesoModule } from "./modules/acceso/acceso.module.js";
import { ArchivosModule } from "./modules/archivos/archivos.module.js";
import { AuditoriaModule } from "./modules/auditoria/auditoria.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { ClientesModule } from "./modules/clientes/clientes.module.js";
import { ComprasModule } from "./modules/compras/compras.module.js";
import { CredencialesModule } from "./modules/credenciales/credenciales.module.js";
import { EstudioModule } from "./modules/estudio/estudio.module.js";
import { ImportacionModule } from "./modules/importacion/importacion.module.js";
import { NotificacionesModule } from "./modules/notificaciones/notificaciones.module.js";
import { PlanesModule } from "./modules/planes/planes.module.js";
import { PlataformaModule } from "./modules/plataforma/plataforma.module.js";
import { RegistroModule } from "./modules/registro/registro.module.js";
import { ReglasModule } from "./modules/reglas/reglas.module.js";
import { StorageModule } from "./modules/storage/storage.module.js";
import type { OpcionesRedisTrabajos } from "./modules/trabajos/redis.js";
import { TrabajosModule } from "./modules/trabajos/trabajos.module.js";
import { VentasModule } from "./modules/ventas/ventas.module.js";

/** Dependencias de la raíz: las del núcleo, el Redis de trabajos (008) y el storage de XML (016). */
export interface DependenciasApp extends DependenciasNucleo {
  redis: OpcionesRedisTrabajos;
  storage: StorageProvider;
}

/** Raíz de la app: `crearApp` aporta las dependencias (BD, hasher, cola de correo, comunes, origen, Redis). */
@Module({})
export class AppModule {
  static registrar({ redis, storage, ...dependencias }: DependenciasApp): DynamicModule {
    return {
      module: AppModule,
      imports: [
        NucleoModule.registrar(dependencias),
        AuthModule,
        EstudioModule,
        AccesoModule,
        ClientesModule,
        CredencialesModule,
        ImportacionModule,
        PlanesModule,
        RegistroModule,
        PlataformaModule,
        // Antes que Ventas y Compras: sus `GET :ventaId` / `GET :compraId` capturarían `archivos` (spec 012b).
        ArchivosModule,
        VentasModule,
        ComprasModule,
        ReglasModule,
        // Spec 017: rutas estáticas de `/notificaciones` y `/auditoria`; no chocan con ningún `:id` anterior.
        NotificacionesModule,
        AuditoriaModule,
        TrabajosModule.registrar(redis),
        StorageModule.registrar(storage),
      ],
    };
  }
}
