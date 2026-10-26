import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { ContappDb } from "@contapp/db";
import type { Hasher } from "../modules/auth/contrasena/hasher.js";
import {
  APP_ORIGIN,
  COLA_CORREO,
  COMUNES,
  DB,
  HASHER,
} from "../modules/auth/inyeccion.js";
import type { ColaCorreo } from "./correo/cola.js";

/** Dependencias que `crearApp` arma una vez y comparte con todos los módulos. */
export interface DependenciasNucleo {
  db: ContappDb;
  hasher: Hasher;
  cola: ColaCorreo;
  comunes: ReadonlySet<string>;
  appOrigin: string;
}

/** Cierra el pool de la BD al cerrar la app (`app.close()`). */
@Injectable()
class CierreDb implements OnModuleDestroy {
  constructor(@Inject(DB) private readonly db: ContappDb) {}

  async onModuleDestroy(): Promise<void> {
    await this.db.close();
  }
}

/** Proveedores compartidos (global): los tokens de `modules/auth/inyeccion.ts`. */
@Global()
@Module({})
export class NucleoModule {
  static registrar(d: DependenciasNucleo): DynamicModule {
    const tokens = [
      { provide: DB, useValue: d.db },
      { provide: HASHER, useValue: d.hasher },
      { provide: COLA_CORREO, useValue: d.cola },
      { provide: COMUNES, useValue: d.comunes },
      { provide: APP_ORIGIN, useValue: d.appOrigin },
    ];
    return {
      module: NucleoModule,
      providers: [...tokens, CierreDb],
      exports: tokens.map((t) => t.provide),
    };
  }
}
