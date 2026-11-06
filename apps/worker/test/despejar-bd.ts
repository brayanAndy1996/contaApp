// Spec 009 · T8 (D18, D20): paso previo de `ci:cierre`. Solo con CI=true borra de la BD de pruebas los job_registro
// vivos (en_cola/ejecutando) que dejaron otras suites, con el rol admin de pruebas (MIGRATIONS_DATABASE_URL), para que
// las 3 pruebas de cierre de 008 corran en serie con la BD despejada. Sin CI no toca nada.
// No desactiva RLS: el rol admin tiene que ser superusuario o BYPASSRLS (se comprueba antes de borrar, porque con
// FORCE RLS un borrado sin ese privilegio afectaría 0 filas sin error). Exige el binario redis-server, porque sin él
// las pruebas de cierre se omitirían en silencio (describe.skipIf). Nunca imprime URLs ni valores de conexión.
import { spawnSync } from "node:child_process";
import { createDb } from "@contapp/db";

const ESTADOS_VIVOS = ["en_cola", "ejecutando"];

/** Borra los trabajos vivos con el rol admin y devuelve cuántos. Lanza si el rol no puede saltarse la RLS. */
async function despejar(url: string): Promise<number> {
  const admin = createDb({ rolApp: "contapp_worker", url, poolMax: 1 });
  try {
    const privilegio = await admin.pool.query<{ bypass: boolean }>(
      "select (rolsuper or rolbypassrls) as bypass from pg_roles where rolname = current_user",
    );
    if (privilegio.rows[0]?.bypass !== true) {
      throw new Error(
        "despejar-bd: el rol admin de pruebas no es superusuario ni BYPASSRLS; no se despeja sin desactivar RLS",
      );
    }
    const borrados = await admin.pool.query(
      "delete from job_registro where estado = any($1::text[])",
      [ESTADOS_VIVOS],
    );
    const quedan = await admin.pool.query<{ n: number }>(
      "select count(*)::int as n from job_registro where estado = any($1::text[])",
      [ESTADOS_VIVOS],
    );
    if (quedan.rows[0]?.n !== 0) {
      throw new Error("despejar-bd: siguen quedando trabajos vivos tras borrarlos");
    }
    return borrados.rowCount ?? 0;
  } finally {
    await admin.close();
  }
}

async function main(): Promise<void> {
  if (process.env.CI !== "true") {
    console.log("despejar-bd: sin CI=true no se borra nada");
    return;
  }
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("despejar-bd: falta MIGRATIONS_DATABASE_URL (rol admin de pruebas)");
  if (spawnSync("redis-server", ["--version"]).status !== 0) {
    throw new Error(
      "despejar-bd: falta el binario redis-server; sin él las pruebas de cierre se omitirían en silencio",
    );
  }
  const borrados = await despejar(url);
  console.log(`despejar-bd: ${borrados} trabajos vivos borrados; BD despejada`);
}

/** Mensaje para la consola: los errores propios tal cual; los de la BD solo con su código (nunca la conexión). */
function diagnostico(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("despejar-bd:")) return error.message;
  const codigo = (error as { code?: unknown } | null)?.code;
  const detalle = typeof codigo === "string" ? codigo : "desconocido";
  return `despejar-bd: fallo con la BD de pruebas (código ${detalle}); no se muestran conexiones`;
}

main().catch((error: unknown) => {
  console.error(diagnostico(error));
  process.exitCode = 1;
});
