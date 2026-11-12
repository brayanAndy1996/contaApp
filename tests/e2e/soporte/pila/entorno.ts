// Entorno de la pila E2E (spec 018, D-2 y D-3; plan «Entorno de la pila»). Es el único punto que lee
// `.env` para la E2E: arma el entorno de backend, worker y frontend de forma explícita. No imprime ni
// registra valores: los errores nombran la variable, nunca su contenido.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Raíz del repo: `soporte/pila` está a cuatro niveles de `tests/e2e`. */
export const RAIZ = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export const PUERTO_FRONTEND = 3210;
export const PUERTO_BACKEND = 4210;
export const URL_FRONTEND = `http://localhost:${PUERTO_FRONTEND}`;
export const URL_BACKEND = `http://localhost:${PUERTO_BACKEND}`;

/** La única BD que la E2E crea, migra y borra. Nunca es `contapp` (la de desarrollo). */
export const BD_E2E = "contapp_e2e";

export type ModoCorreo = "mailpit" | "consola";

export interface ConfigE2E {
  readonly modoCorreo: ModoCorreo;
  readonly conservarBd: boolean;
  readonly redisDb: number;
  readonly mailpitSmtpPort: number;
  readonly mailpitUiPort: number;
  /** Superusuario en `contapp_e2e`: para migrar y sembrar. */
  readonly urlMigraciones: string;
  /** Superusuario en `postgres`: para crear y borrar `contapp_e2e`. */
  readonly urlMantenimiento: string;
  /** Rol de la app en `contapp_e2e`. */
  readonly urlApp: string;
  /** Redis en el índice propio de la corrida (E2E_REDIS_DB). */
  readonly urlRedis: string;
}

/** Carga `.env` de la raíz en `process.env`. No pisa lo que el proceso ya trae (p. ej. el CI). */
export function cargarDotenv(): void {
  const ruta = join(RAIZ, ".env");
  if (existsSync(ruta)) process.loadEnvFile(ruta);
}

function urlConRuta(url: string, ruta: string, variable: string): string {
  try {
    const u = new URL(url);
    u.pathname = `/${ruta}`;
    return u.toString();
  } catch {
    throw new Error(`${variable} no es una URL válida (ver .env.example).`);
  }
}

function puerto(
  valor: string | undefined,
  porDefecto: number,
  variable: string,
): number {
  const numero = Number(valor ?? porDefecto);
  if (!Number.isInteger(numero) || numero < 1 || numero > 65535) {
    throw new Error(`${variable} debe ser un puerto válido.`);
  }
  return numero;
}

/** Lee y valida la configuración de la E2E. Lanza un error que nombra la variable mal puesta. */
export function leerConfig(env: NodeJS.ProcessEnv = process.env): ConfigE2E {
  const requerida = (nombre: string): string => {
    const valor = env[nombre];
    if (valor === undefined || valor.trim() === "") {
      throw new Error(`Falta ${nombre} (en .env; ver .env.example).`);
    }
    return valor;
  };

  const modo = env.E2E_CORREO ?? "mailpit";
  if (modo !== "mailpit" && modo !== "consola") {
    throw new Error('E2E_CORREO debe ser "mailpit" o "consola".');
  }
  const conservar = env.E2E_CONSERVAR_BD ?? "0";
  if (conservar !== "0" && conservar !== "1") {
    throw new Error('E2E_CONSERVAR_BD debe ser "1" o "0".');
  }
  const redisDb = Number(env.E2E_REDIS_DB ?? "15");
  if (!Number.isInteger(redisDb) || redisDb < 1 || redisDb > 15) {
    throw new Error(
      "E2E_REDIS_DB debe ser un entero de 1 a 15 (el índice 0 es el de desarrollo).",
    );
  }

  const migraciones = requerida("MIGRATIONS_DATABASE_URL");
  return {
    modoCorreo: modo,
    conservarBd: conservar === "1",
    redisDb,
    mailpitSmtpPort: puerto(env.MAILPIT_SMTP_PORT, 1025, "MAILPIT_SMTP_PORT"),
    mailpitUiPort: puerto(env.MAILPIT_UI_PORT, 8025, "MAILPIT_UI_PORT"),
    urlMigraciones: urlConRuta(migraciones, BD_E2E, "MIGRATIONS_DATABASE_URL"),
    urlMantenimiento: urlConRuta(
      migraciones,
      "postgres",
      "MIGRATIONS_DATABASE_URL",
    ),
    urlApp: urlConRuta(requerida("DATABASE_URL"), BD_E2E, "DATABASE_URL"),
    urlRedis: urlConRuta(requerida("REDIS_URL"), String(redisDb), "REDIS_URL"),
  };
}

/**
 * Entorno de backend, worker y frontend: el de `base` (con `.env` cargado) más lo que fija la E2E.
 * Todo adaptador va en `mock`; el correo, en `smtp` contra Mailpit o en `consola` (stdout del backend).
 */
export function entornoDeLaPila(
  config: ConfigE2E,
  dirTmp: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [nombre, valor] of Object.entries(base)) {
    if (valor !== undefined) env[nombre] = valor;
  }
  Object.assign(env, {
    NODE_ENV: "development",
    PORT: String(PUERTO_BACKEND),
    APP_ORIGIN: URL_FRONTEND,
    BACKEND_URL: URL_BACKEND,
    TRUST_PROXY: "loopback",
    DATABASE_URL: config.urlApp,
    MIGRATIONS_DATABASE_URL: config.urlMigraciones,
    REDIS_URL: config.urlRedis,
    SIRE_CLIENT: "mock",
    SOL_PORTAL: "mock",
    RUC_CLIENT: "mock",
    XML_PROVIDER: "mock",
    KEY_PROVIDER: "mock",
    STORAGE: "local",
    STORAGE_DIR: join(dirTmp, "storage"),
    XML_SIMULADO_EN_REGLAS: "1",
    ARGON2_MEMORIA_KIB: "19456",
    ARGON2_ITERACIONES: "2",
    ARGON2_PARALELISMO: "1",
  });
  if (config.modoCorreo === "mailpit") {
    Object.assign(env, {
      CORREO_PROVIDER: "smtp",
      SMTP_URL: `smtp://localhost:${config.mailpitSmtpPort}`,
      CORREO_REMITENTE: "e2e@contapp.test",
    });
  } else {
    env.CORREO_PROVIDER = "consola";
    delete env.SMTP_URL;
  }
  return env;
}
