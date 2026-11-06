// Módulo Nest del worker de trabajos (spec 008). Arranca `iniciarTrabajos` con la BD (rol contapp_worker), Redis
// (REDIS_URL) y la KEK activa del entorno, y al cerrar el proceso hace el cierre ordenado: deja de tomar trabajos,
// espera a los en curso hasta 30 s y libera sus arriendos. Los adaptadores (SIRE, SOL, RUC, XML) los crea `adaptadores.module.ts` (009).
import {
  Inject,
  Injectable,
  Module,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { dirname, join } from "node:path";
import {
  crearKeyUnwrapper,
  crearKeyUnwrapperAnterior,
} from "@contapp/crypto/descifrado";
import { createDb, type ContappDb } from "@contapp/db";
import {
  ADAPTADORES,
  crearAdaptadores,
  type Adaptadores,
} from "../adaptadores/adaptadores.module.js";
import { Redis } from "ioredis";
import { conexionDesdeUrl } from "./conexion.js";
import {
  iniciarTrabajos,
  type LlavesKek,
  type TrabajosEnMarcha,
} from "./iniciar.js";

// Se movieron a `adaptadores.module.ts` (009, D8); se reexportan con el mismo nombre.
export {
  ConfiguracionTrabajosError,
  consultaRucDesdeEntorno,
  sireAuthDesdeEntorno,
  solAuthDesdeEntorno,
} from "../adaptadores/adaptadores.module.js";

/**
 * Llaves para `kek.rotar`: la activa del entorno (KEY_PROVIDER, KEK_ID, KEK_PRIVATE_KEY_PATH) y la anterior `desde`,
 * que se busca junto a la activa como `<desde>.pem` (no hay variables nuevas; con `mock` la rotación se rechaza).
 */
export function llavesDesdeEntorno(
  env: Record<string, string | undefined>,
): LlavesKek {
  const activa = crearKeyUnwrapper(env);
  return {
    activa,
    anterior: (desde) =>
      crearKeyUnwrapperAnterior({
        kekId: desde,
        rutaPrivada: join(
          dirname(String(env.KEK_PRIVATE_KEY_PATH ?? ".")),
          `${desde}.pem`,
        ),
      }),
  };
}

@Injectable()
export class TrabajosService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private db?: ContappDb;
  private redis?: Redis;
  private enMarcha?: TrabajosEnMarcha;

  /** Los adaptadores los entrega `AdaptadoresModule`; sin él (pruebas unitarias) se crean del entorno. */
  constructor(
    @Optional() @Inject(ADAPTADORES) private readonly adaptadores?: Adaptadores,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const env = process.env;
    const conexionBull = conexionDesdeUrl(env.REDIS_URL);
    this.db = createDb({ rolApp: "contapp_worker" });
    this.redis = new Redis(String(env.REDIS_URL));
    const adaptadores = this.adaptadores ?? crearAdaptadores(env);
    this.enMarcha = await iniciarTrabajos({
      db: this.db,
      redis: this.redis,
      conexionBull,
      sireAuth: adaptadores.sireAuth,
      consultaRuc: adaptadores.consultaRuc,
      solAuth: adaptadores.solAuth,
      kek: llavesDesdeEntorno(env),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.enMarcha?.detener({ esperaMs: 30_000 });
    } finally {
      this.redis?.disconnect();
      // Con la BD sin responder (red partida), `pool.end()` espera para siempre a las conexiones prestadas: el cierre
      // tiene tope (H-008-2a-5) y luego el proceso sale igual (`useProcessExit`); las conexiones mueren con él.
      if (this.db !== undefined)
        await cerrarConTope(this.db.close(), ESPERA_CIERRE_BD_MS);
    }
  }
}

/** Tope del cierre del pool de la BD tras detener los trabajos (H-008-2a-5). */
export const ESPERA_CIERRE_BD_MS = 2_000;

/** Espera `p` hasta `ms`; nunca lanza (un fallo o el tope se ignoran: el proceso está saliendo). */
export async function cerrarConTope(
  p: Promise<unknown>,
  ms: number,
): Promise<void> {
  let reloj: NodeJS.Timeout | undefined;
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((r) => {
      reloj = setTimeout(r, ms);
      reloj.unref?.();
    }),
  ]);
  clearTimeout(reloj);
}

@Module({ providers: [TrabajosService] })
export class TrabajosModule {}
