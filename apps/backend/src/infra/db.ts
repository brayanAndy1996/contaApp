import { createDb, type ContappDb } from "@contapp/db";
import type { EnvCrudo } from "../config/entorno.js";

/**
 * Conexión de la app como `contapp_backend` (única con permiso para `withAuth`). La URL sale de
 * `DATABASE_URL` del entorno inyectado; sin ella `createDb` usa el entorno del proceso. Nunca se
 * registra: puede llevar credenciales.
 */
export function crearDb(env: EnvCrudo): ContappDb {
  const url = env.DATABASE_URL;
  return createDb({
    rolApp: "contapp_backend",
    ...(url === undefined || url === "" ? {} : { url }),
  });
}
