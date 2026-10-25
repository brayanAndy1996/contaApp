// `pnpm db:migrate`: aplica las migraciones con MIGRATIONS_DATABASE_URL (superusuario) y sincroniza
// la contraseña de contapp_app con la de DATABASE_URL enviando solo un verificador SCRAM (plan 002).
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { generaVerificador, verificaPassword } from "../scram";
import { ejecutar, ErrorCli, urlMigraciones } from "./comun";

const ROL_LOGIN = "contapp_app";
const CARPETA_MIGRACIONES = path.resolve(__dirname, "../../migrations");
const FORMATO_VERIFICADOR = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

/** Contraseña del rol de login tomada de DATABASE_URL; valida usuario y presencia sin revelar valores. */
export function passwordDeDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new ErrorCli("falta DATABASE_URL");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new ErrorCli("DATABASE_URL no es una URL valida");
  }
  if (decodeURIComponent(url.username) !== ROL_LOGIN) {
    throw new ErrorCli(`DATABASE_URL debe conectar con el rol ${ROL_LOGIN}`);
  }
  const password = decodeURIComponent(url.password);
  if (!password) throw new ErrorCli("DATABASE_URL no tiene contrasena");
  return password;
}

async function sincronizarPassword(client: Client, password: string): Promise<"sin cambios" | "actualizada"> {
  const r = await client.query<{ rolpassword: string | null }>(
    "select rolpassword from pg_authid where rolname = $1",
    [ROL_LOGIN],
  );
  if (r.rowCount !== 1) throw new ErrorCli(`no existe el rol ${ROL_LOGIN}`);
  const actual = r.rows[0]!.rolpassword;
  if (actual && actual.startsWith("SCRAM-SHA-256$") && verificaPassword(actual, password)) {
    return "sin cambios";
  }
  const verificador = generaVerificador(password);
  // ALTER ROLE no admite parámetros: el verificador se valida contra su formato antes de interpolarlo.
  if (!FORMATO_VERIFICADOR.test(verificador)) throw new ErrorCli("verificador SCRAM con formato invalido");
  await client.query(`ALTER ROLE ${ROL_LOGIN} PASSWORD '${verificador}'`);
  return "actualizada";
}

async function main(): Promise<void> {
  const urlMigr = urlMigraciones();
  const password = passwordDeDatabaseUrl(process.env.DATABASE_URL);
  const client = new Client({ connectionString: urlMigr });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: CARPETA_MIGRACIONES });
    const estado = await sincronizarPassword(client, password);
    console.log(`migrar: contrasena de ${ROL_LOGIN} ${estado}`);
  } finally {
    await client.end();
  }
}

if (require.main === module) ejecutar("migrar", main);
