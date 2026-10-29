// `pnpm --filter @contapp/worker trabajos:kek-rotar --desde <kekId>` (spec 008, D10, CA-12). Encola en BullMQ (cola
// `programados`) un job `kek.rotar` con data exacta { tipo: "kek.rotar", desde }; el worker lo ejecuta rotando todos los
// estudios. Valida los argumentos ANTES de tocar Redis. La salida nunca incluye REDIS_URL ni credenciales.
// `main` nunca lanza; devuelve el código de salida: 0 encolado · 1 error (Redis, configuración) · 2 uso.
import { pathToFileURL } from "node:url";
import { crearColaSistema, type ConexionBull } from "@contapp/queue/worker";
import { esKekId } from "../credenciales/errores.js";
import {
  conexionDesdeUrl,
  RedisUrlInvalidaError,
} from "../trabajos/conexion.js";

export interface DepsEncolarKekRotar {
  /** Por defecto, la de REDIS_URL. */
  conexionBull?: ConexionBull;
  prefijo?: string;
  escribir?: (linea: string) => void;
  escribirError?: (linea: string) => void;
}

const USO = "uso: trabajos:kek-rotar --desde <kekId>";

/** kekId de `--desde`, o null si los argumentos no son exactamente `--desde <kekId>`. */
function parsear(argv: readonly string[]): string | null {
  // `pnpm … -- --desde k1` puede dejar pasar el separador inicial: se ignora.
  const t = argv[0] === "--" ? argv.slice(1) : argv;
  if (t.length !== 2 || t[0] !== "--desde" || !esKekId(t[1])) return null;
  return t[1];
}

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: DepsEncolarKekRotar = {},
): Promise<number> {
  const escribir = deps.escribir ?? console.log;
  const escribirError = deps.escribirError ?? console.error;
  const desde = parsear(argv);
  if (desde === null) {
    escribirError(USO);
    return 2;
  }
  let cola: ReturnType<typeof crearColaSistema> | undefined;
  try {
    const conexion = deps.conexionBull ?? conexionDesdeUrl(env.REDIS_URL);
    cola = crearColaSistema({
      conexion,
      ...(deps.prefijo === undefined ? {} : { prefijo: deps.prefijo }),
    });
    await cola.encolar({ tipo: "kek.rotar", desde });
    escribir(`kek.rotar encolado (desde ${desde})`);
    return 0;
  } catch (e) {
    escribirError(
      e instanceof RedisUrlInvalidaError
        ? `trabajos:kek-rotar: ${e.message}`
        : "trabajos:kek-rotar: no se pudo encolar",
    );
    return 1;
  } finally {
    try {
      await cola?.cerrar();
    } catch {
      // cerrar no cambia el resultado; main nunca lanza
    }
  }
}

if (import.meta.url === pathToFileURL(String(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
