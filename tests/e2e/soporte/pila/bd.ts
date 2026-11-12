// Base de datos y Redis de la E2E (spec 018, D-3). Cada corrida crea, migra y siembra `contapp_e2e`, y
// vacía su índice de Redis. Solo `contapp_e2e` se crea y se borra: la BD de desarrollo no se toca.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { Redis } from "ioredis";
import { Client } from "pg";
import { BD_E2E, RAIZ } from "./entorno.js";
import { ultimasLineas } from "./procesos.js";

function codigoDe(error: unknown): string {
  const codigo = (error as { code?: unknown }).code;
  return typeof codigo === "string" ? codigo : "error";
}

async function conectar(url: string, variable: string): Promise<Client> {
  const cliente = new Client({ connectionString: url });
  try {
    await cliente.connect();
  } catch (error) {
    throw new Error(
      `No se pudo conectar a PostgreSQL con ${variable} (${codigoDe(error)}).`,
    );
  }
  return cliente;
}

/**
 * Crea `contapp_e2e`. Devuelve `true` si la creó: esa corrida es la que la borra al terminar.
 * Si ya existe, falla (quedó de una corrida interrumpida) salvo con `conservar`, que la reutiliza.
 */
export async function crearBd(
  urlMantenimiento: string,
  conservar: boolean,
): Promise<boolean> {
  const cliente = await conectar(urlMantenimiento, "MIGRATIONS_DATABASE_URL");
  try {
    const { rows } = await cliente.query(
      "SELECT 1 AS existe FROM pg_database WHERE datname = $1",
      [BD_E2E],
    );
    if (rows.length > 0) {
      if (conservar) return false;
      throw new Error(
        `La BD ${BD_E2E} ya existe (¿quedó de una corrida interrumpida?). Bórrala con «DROP DATABASE ${BD_E2E};» o corre con E2E_CONSERVAR_BD=1.`,
      );
    }
    await cliente.query(`CREATE DATABASE "${BD_E2E}"`);
    return true;
  } finally {
    await cliente.end();
  }
}

/** Borra `contapp_e2e`. Solo se llama si la corrida la creó y no se pidió conservarla. */
export async function borrarBd(urlMantenimiento: string): Promise<void> {
  const cliente = await conectar(urlMantenimiento, "MIGRATIONS_DATABASE_URL");
  try {
    await cliente.query(`DROP DATABASE IF EXISTS "${BD_E2E}" WITH (FORCE)`);
  } finally {
    await cliente.end();
  }
}

/** Ejecuta una CLI de `@contapp/db` (`db:migrate` o `db:seed`) con el entorno de la pila. */
export function ejecutarCliDb(
  comando: "migrar" | "seed",
  env: Record<string, string>,
): Promise<void> {
  const ruta = join(RAIZ, "packages/db/dist/cli", `${comando}.js`);
  return new Promise((resolver, rechazar) => {
    execFile(
      process.execPath,
      [ruta],
      { cwd: join(RAIZ, "packages/db"), env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolver();
          return;
        }
        const codigo = String(error.code ?? "?");
        rechazar(
          new Error(
            `db:${comando} falló (código ${codigo}). Últimas líneas:\n${ultimasLineas(`${stdout}${stderr}`)}`,
          ),
        );
      },
    );
  });
}

/** Vacía el índice de Redis de la corrida (solo ese índice: `FLUSHDB`, nunca `FLUSHALL`). */
export async function vaciarIndiceRedis(urlRedis: string): Promise<void> {
  const redis = new Redis(urlRedis, {
    lazyConnect: true,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.flushdb();
  } catch {
    throw new Error(
      "No se pudo vaciar el índice de Redis de la E2E (REDIS_URL).",
    );
  } finally {
    redis.disconnect();
  }
}
