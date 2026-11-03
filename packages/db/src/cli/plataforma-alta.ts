// `pnpm --filter @contapp/db db:plataforma-alta`: alta de un super-admin de plataforma (spec 006, P-T15-1).
//
// Uso (con MIGRATIONS_DATABASE_URL; funciona con NODE_ENV=production, a diferencia de db:seed):
//   node dist/cli/plataforma-alta.js --correo <correo> [--nombre <nombre>]
//
//  - Usuario existente: se agrega a `admin_plataforma` (sin membresía; no se toca ni se pide su contraseña).
//  - Usuario nuevo: se crea con su contraseña en argon2id y alta en `admin_plataforma`, sin membresía, en una
//    sola transacción. La contraseña sale de CONTAPP_PLATAFORMA_CONTRASENA o, si falta, de stdin (por tubería:
//    `printf '%s' "$CLAVE" | pnpm --filter @contapp/db db:plataforma-alta --correo a@x.pe`). Se valida con la
//    política de contraseñas (12..128 puntos de código y fuera de la lista de comunes del backend).
//  - Idempotente: repetirlo no duplica nada, no cambia el hash y responde "sin cambios".
//  - Nunca imprime ni registra la contraseña, el hash ni la URL de conexión; los errores llevan mensajes fijos.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash as argon2Hash } from "@node-rs/argon2";
import {
  CorreoNoAsciiError,
  longitudContrasenaValida,
  normalizarCorreo,
} from "@contapp/shared";
import { Client } from "pg";
import { ErrorCli, ejecutarSiDirecta, urlMigraciones } from "./comun";

/** Resultado de leer los argumentos del CLI: el correo ya normalizado (trim, minúsculas, NFC, ASCII). */
export interface ArgumentosAlta {
  correo: string;
  nombre?: string;
}

const CORREO_MAX = 254;
const PATRON_CORREO = /^[^\s@]+@[^\s@]+$/;
/** Mismos parámetros argon2id que el backend (piso OWASP: m=19456 KiB, t=2, p=1); 2 = Argon2id. */
const OPCIONES_ARGON2 = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
/** Lista de contraseñas comunes de la política (vive en el backend; este CLI se corre desde el repo). */
export const RUTA_COMUNES = resolve(
  __dirname,
  "../../../../apps/backend/src/modules/auth/contrasena/comunes.txt",
);

function correoValido(crudo: string): string {
  let correo: string;
  try {
    correo = normalizarCorreo(crudo);
  } catch (e) {
    if (e instanceof CorreoNoAsciiError) throw new ErrorCli("correo inválido: solo se admiten caracteres ASCII");
    throw e;
  }
  if (correo.length > CORREO_MAX || !PATRON_CORREO.test(correo))
    throw new ErrorCli("correo inválido");
  return correo;
}

export function parsearArgumentos(argv: readonly string[]): ArgumentosAlta {
  let correo: string | undefined;
  let nombre: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const clave = argv[i];
    const valor = argv[i + 1];
    if (clave !== "--correo" && clave !== "--nombre")
      throw new ErrorCli("argumento desconocido: use --correo <correo> [--nombre <nombre>]");
    if (valor === undefined) throw new ErrorCli(`falta el valor de ${clave}`);
    if (clave === "--correo") {
      if (correo !== undefined) throw new ErrorCli("--correo se indica una sola vez");
      correo = correoValido(valor);
    } else {
      if (nombre !== undefined) throw new ErrorCli("--nombre se indica una sola vez");
      nombre = valor.trim();
      if (nombre === "") throw new ErrorCli("--nombre no puede estar vacío");
    }
  }
  if (correo === undefined) throw new ErrorCli("falta --correo <correo>");
  return nombre === undefined ? { correo } : { correo, nombre };
}

/** Carga la lista de contraseñas comunes (una por línea, minúsculas). Si no se encuentra, falla cerrado. */
export function cargarComunes(ruta: string = RUTA_COMUNES): ReadonlySet<string> {
  let texto: string;
  try {
    texto = readFileSync(ruta, "utf8");
  } catch {
    throw new ErrorCli("no se encontró la lista de contraseñas comunes; ejecute el CLI desde el repositorio");
  }
  const comunes = new Set<string>();
  for (const linea of texto.split(/\r?\n/)) {
    const entrada = linea.trim().toLowerCase();
    if (entrada !== "") comunes.add(entrada);
  }
  return comunes;
}

/** Política de contraseñas (spec 004, P5): longitud 12..128 puntos de código y no estar en la lista de comunes. */
export function validarContrasenaNueva(plano: string, comunes: ReadonlySet<string>): void {
  if (!longitudContrasenaValida(plano))
    throw new ErrorCli("contraseña inválida: debe tener entre 12 y 128 caracteres");
  if (comunes.has(plano.toLowerCase()))
    throw new ErrorCli("contraseña inválida: es una contraseña demasiado común");
}

/** Lee toda la entrada estándar; con una terminal interactiva no se pide la contraseña (se mostraría en pantalla). */
export async function leerStdinProceso(
  entrada: AsyncIterable<string | Buffer> & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (entrada.isTTY === true)
    throw new ErrorCli("contraseña: use CONTAPP_PLATAFORMA_CONTRASENA o páselo por tubería (stdin)");
  const trozos: Buffer[] = [];
  for await (const t of entrada) trozos.push(Buffer.from(t));
  return Buffer.concat(trozos).toString("utf8");
}

async function obtenerContrasena(
  env: NodeJS.ProcessEnv,
  leerStdin: () => Promise<string>,
): Promise<string> {
  const deEntorno = env.CONTAPP_PLATAFORMA_CONTRASENA;
  const plano =
    deEntorno !== undefined && deEntorno !== "" ? deEntorno : (await leerStdin()).replace(/\r?\n$/, "");
  if (plano === "")
    throw new ErrorCli("falta la contraseña: use CONTAPP_PLATAFORMA_CONTRASENA o stdin");
  return plano;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  leerStdin: () => Promise<string> = leerStdinProceso,
): Promise<void> {
  const { correo, nombre } = parsearArgumentos(argv); // antes de abrir la conexión
  const client = new Client({ connectionString: urlMigraciones() });
  await client.connect();
  try {
    await client.query("begin");
    const existente = await client.query<{ id: string }>("select id from usuario where email = $1", [correo]);
    let usuarioId: string;
    let creado = false;
    if (existente.rowCount === 1) {
      usuarioId = existente.rows[0]!.id;
    } else {
      const plano = await obtenerContrasena(env, leerStdin);
      validarContrasenaNueva(plano, cargarComunes());
      const phc = await argon2Hash(plano, OPCIONES_ARGON2);
      const u = await client.query<{ id: string }>(
        "insert into usuario (email, nombre) values ($1, $2) returning id",
        [correo, nombre ?? correo.split("@")[0]],
      );
      usuarioId = u.rows[0]!.id;
      await client.query("insert into auth.usuario_contrasena (usuario_id, hash) values ($1, $2)", [usuarioId, phc]);
      creado = true;
    }
    const alta = await client.query(
      "insert into admin_plataforma (usuario_id) values ($1) on conflict (usuario_id) do nothing",
      [usuarioId],
    );
    await client.query("commit");
    console.log(
      creado ? "super-admin creado" : alta.rowCount === 1 ? "super-admin agregado" : "sin cambios",
    );
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

ejecutarSiDirecta(require.main, module, "plataforma-alta", main);
