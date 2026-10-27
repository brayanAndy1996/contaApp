// `pnpm db:migrate`: aplica las migraciones con MIGRATIONS_DATABASE_URL (superusuario), repara los
// ajustes persistentes y atributos de contapp_app (H7) y sincroniza su contraseña con la de
// DATABASE_URL enviando solo un verificador SCRAM (plan 002).
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { generaVerificador, verificaPassword } from "../scram";
import { ejecutarSiDirecta, ErrorCli, urlMigraciones } from "./comun";
import { repararRolLogin, ROL_LOGIN } from "./reparar-rol";
const CARPETA_MIGRACIONES = path.resolve(__dirname, "../../migrations");
const FORMATO_VERIFICADOR =
  /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

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

export async function sincronizarPassword(
  client: Pick<Client, "query">,
  password: string,
): Promise<"sin cambios" | "actualizada"> {
  const r = await client.query<{ rolpassword: string | null }>(
    "select rolpassword from pg_authid where rolname = $1",
    [ROL_LOGIN],
  );
  if (r.rowCount !== 1) throw new ErrorCli(`no existe el rol ${ROL_LOGIN}`);
  const actual = r.rows[0]!.rolpassword;
  if (
    actual &&
    actual.startsWith("SCRAM-SHA-256$") &&
    verificaPassword(actual, password)
  ) {
    return "sin cambios";
  }
  const verificador = generaVerificador(password);
  if (!FORMATO_VERIFICADOR.test(verificador))
    throw new ErrorCli("verificador SCRAM con formato invalido");
  // ALTER ROLE no admite parámetros: el servidor arma la sentencia con format(%I, %L) a partir de
  // valores enviados como $1/$2 (nunca se interpola en el cliente) y luego se ejecuta tal cual.
  const ddl = await client.query<{ sentencia: string }>(
    "select format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) as sentencia",
    [ROL_LOGIN, verificador],
  );
  await client.query(ddl.rows[0]!.sentencia);
  return "actualizada";
}

type Conexion = Pick<Client, "query">;
/** Aplica las migraciones de drizzle; inyectable para probar `migrar` sin base de datos. */
export type Aplicador = (client: Conexion) => Promise<void>;

export const aplicarMigraciones: Aplicador = async (client) => {
  await migrate(drizzle(client as Client), {
    migrationsFolder: CARPETA_MIGRACIONES,
  });
};

/** Migra, repara el rol y sincroniza su contraseña (en una transacción). Devuelve las líneas a mostrar. */
export async function migrar(
  client: Conexion,
  password: string,
  aplicar: Aplicador = aplicarMigraciones,
): Promise<string[]> {
  await aplicar(client);
  // Reparación y contraseña en una sola transacción: no queda el rol a medio reparar.
  await client.query("BEGIN");
  try {
    const rep = await repararRolLogin(client);
    const estado = await sincronizarPassword(client, password);
    await client.query("COMMIT");
    return [
      `migrar: ajustes de ${ROL_LOGIN} ${rep.ajustes}`,
      `migrar: atributos de ${ROL_LOGIN} ${rep.atributos}`,
      `migrar: contrasena de ${ROL_LOGIN} ${estado}`,
    ];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

export async function main(): Promise<void> {
  const urlMigr = urlMigraciones();
  const password = passwordDeDatabaseUrl(process.env.DATABASE_URL);
  const client = new Client({ connectionString: urlMigr });
  await client.connect();
  try {
    for (const linea of await migrar(client, password)) console.log(linea);
  } finally {
    await client.end();
  }
}

ejecutarSiDirecta(require.main, module, "migrar", main);
