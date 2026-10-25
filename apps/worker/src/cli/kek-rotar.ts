// `pnpm kek:rotar -- --desde <kekId> --privada-anterior <ruta> --tenant <uuid> [--tenant <uuid>…]`
// (spec 003, D6; CA-6). Re-envuelve las DEK de cada estudio de la KEK `desde` (llave privada recibida
// por argumento) a la KEK activa del entorno (KEY_PROVIDER, KEK_ID, KEK_PRIVATE_KEY_PATH).
// Valida argumentos, entorno y llaves ANTES de tocar la BD. La salida trae solo ids de estudio y
// conteos: nunca llaves, rutas de llaves, URLs ni stacks. `main` nunca lanza: devuelve el código de salida.
import { pathToFileURL } from "node:url";
import {
  CryptoError,
  RotacionConMockError,
  crearKeyUnwrapper,
  crearKeyUnwrapperAnterior,
  esLlaveMock,
} from "@contapp/crypto/descifrado";
import { ConfiguracionDbError, createDb, type ContappDb } from "@contapp/db";
import {
  ArgumentoInvalidoError,
  CredencialesWorkerError,
  esKekId,
  esUuid,
} from "../credenciales/errores.js";
import { rotarKekTenant } from "../credenciales/rotar-kek.js";

export interface DepsKekRotar {
  /** Por defecto createDb({ rolApp: "contapp_worker", url: env.DATABASE_URL }), cerrada al terminar. */
  db?: Pick<ContappDb, "withTenant">;
  escribir?: (linea: string) => void;
  escribirError?: (linea: string) => void;
}

const USO =
  "uso: kek:rotar --desde <kekId> --privada-anterior <ruta> --tenant <uuid> [--tenant <uuid> ...]";

const OPCIONES = ["--desde", "--privada-anterior", "--tenant"] as const;

interface Argumentos {
  desde: string;
  privadaAnterior: string;
  tenants: string[];
}

function parsear(argv: readonly string[]): Argumentos {
  // `pnpm kek:rotar -- …` puede dejar pasar el separador inicial: se ignora.
  const tokens = argv.slice(Number(argv[0] === "--"));
  const valores = new Map<string, string[]>(OPCIONES.map((o) => [o, []]));
  for (let i = 0; i < tokens.length; i += 2) {
    const lista = valores.get(tokens[i]!);
    const valor = tokens[i + 1];
    if (lista === undefined) throw new ArgumentoInvalidoError("opción desconocida o argumento suelto");
    if (valor === undefined) throw new ArgumentoInvalidoError("opción sin valor");
    lista.push(valor);
  }
  const unico = (opcion: (typeof OPCIONES)[number]): string => {
    const lista = valores.get(opcion)!;
    if (lista.length !== 1) throw new ArgumentoInvalidoError(`se requiere un ${opcion}`);
    return lista[0]!;
  };
  const desde = unico("--desde");
  const privadaAnterior = unico("--privada-anterior");
  const tenants = valores.get("--tenant")!;
  if (!esKekId(desde)) throw new ArgumentoInvalidoError("--desde");
  if (tenants.length === 0) throw new ArgumentoInvalidoError("se requiere al menos un --tenant");
  if (!tenants.every(esUuid)) throw new ArgumentoInvalidoError("--tenant");
  return { desde, privadaAnterior, tenants: [...new Set(tenants)] };
}

/** Solo mensajes fijos de errores propios; cualquier otro error se reduce a uno genérico. */
function mensajeDe(e: unknown): string {
  if (e instanceof CryptoError || e instanceof CredencialesWorkerError) {
    return `${e.message} [${e.codigo}]`;
  }
  if (e instanceof ConfiguracionDbError) return e.message;
  return "error inesperado";
}

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: DepsKekRotar = {},
): Promise<number> {
  const { escribir, escribirError } = {
    escribir: console.log,
    escribirError: console.error,
    ...deps,
  };
  const fallar = (e: unknown, codigo: number): number => {
    escribirError(`kek:rotar: ${mensajeDe(e)}`);
    return codigo;
  };

  let args: Argumentos;
  try {
    args = parsear(argv);
  } catch (e) {
    escribirError(USO);
    return fallar(e, 2);
  }

  let propia: ContappDb | undefined;
  let total = { reenvueltas: 0, omitidas: 0 };
  try {
    // createDb no abre conexiones hasta la primera consulta: crearla aquí no toca la BD.
    const db = deps.db ?? (propia = createDb({ rolApp: "contapp_worker", url: env.DATABASE_URL }));
    const activa = crearKeyUnwrapper(env);
    // KEY_PROVIDER=mock (valor por defecto) nunca re-envuelve DEKs reales con la llave del fixture.
    if (esLlaveMock(activa)) throw new RotacionConMockError();
    if (args.desde === activa.kekId) throw new ArgumentoInvalidoError("--desde es la KEK activa");
    const anterior = crearKeyUnwrapperAnterior({
      kekId: args.desde,
      rutaPrivada: args.privadaAnterior,
    });
    await activa.verificar();
    await anterior.verificar();

    for (const tenantId of args.tenants) {
      const r = await rotarKekTenant({ db, anterior, activa, tenantId, desde: args.desde });
      escribir(`estudio ${tenantId}: reenvueltas ${r.reenvueltas}, omitidas ${r.omitidas}`);
      total = {
        reenvueltas: total.reenvueltas + r.reenvueltas,
        omitidas: total.omitidas + r.omitidas,
      };
    }
    escribir(`total: reenvueltas ${total.reenvueltas}, omitidas ${total.omitidas}`);
    return 0;
  } catch (e) {
    return fallar(e, 1);
  } finally {
    try {
      await propia?.close();
    } catch {
      // cerrar el pool propio no cambia el resultado; main nunca lanza
    }
  }
}

if (import.meta.url === pathToFileURL(String(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
