import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { StorageProvider } from "@contapp/storage";

/** Token del `StorageProvider` de XML (spec 016): `STORAGE=mock|local`, lo arma `crearApp` con `crearStorage(env)`. */
export const STORAGE = Symbol("STORAGE_XML");

/**
 * Almacenamiento de archivos (spec 016, plan «Storage»). Global: los módulos que leen o guardan XML inyectan `STORAGE` sin
 * conocer el entorno. La selección y la guarda de producción (`mock` sin `PERMITIR_ADAPTADORES_MOCK=1` no arranca) son de
 * `crearStorage`; este módulo solo lo comparte.
 */
@Global()
@Module({})
export class StorageModule {
  static registrar(storage: StorageProvider): DynamicModule {
    return {
      module: StorageModule,
      global: true,
      providers: [{ provide: STORAGE, useValue: storage }],
      exports: [STORAGE],
    };
  }
}
