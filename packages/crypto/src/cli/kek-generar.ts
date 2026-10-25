// `kek:generar`: crea el par RSA 4096 local (kek-public.pem 0644, kek-private.pem 0600) sin
// sobrescribir archivos existentes. Imprime solo rutas y la huella SHA-256 del SPKI. Dentro del repo
// solo escribe en una carpeta que git ignore (CA-11, T17 · R2b-4).
import { spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPair } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { arrancarSiDirecta } from "../comun/arranque";
import { raizRepo, resolverRuta } from "../comun/raiz";
import { MODULO_MINIMO, huellaSpki } from "../comun/rsa";

export interface OpcionesKekGenerar {
  salida: string;
}
export interface DepsKekGenerar {
  log?: (linea: string) => void;
}
export interface ResultadoKekGenerar {
  rutaPublica: string;
  rutaPrivada: string;
  huella: string;
}

const SALIDA_POR_DEFECTO = "./secrets";
const generarPar = promisify(generateKeyPair);

/**
 * Si `salida` cae dentro del repo, exige que git ignore `kek-private.pem` en ella; si no, la privada
 * quedaría versionable. Sin repositorio git (p. ej. una copia sin `.git`) no hay nada que versionar.
 * El mensaje es fijo: no repite la ruta.
 */
export function exigirSalidaIgnorada(salida: string, raiz: string = raizRepo()): void {
  const rel = relative(raiz, salida);
  if (isAbsolute(rel) || rel.split(sep)[0] === "..") return; // fuera del repo
  const archivo = join(rel, "kek-private.pem").split(sep).join("/");
  const r = spawnSync("git", ["check-ignore", "-q", "--", archivo], {
    cwd: raiz,
    stdio: "ignore",
  });
  if (r.status === 0) return; // git la ignora
  if (r.status !== 1 && !existsSync(join(raiz, ".git"))) return; // no es un repositorio git
  throw new Error(
    "La carpeta de salida está dentro del repositorio y git no la ignora; " +
      "use ./secrets (ignorada) o una carpeta fuera del repositorio.",
  );
}

export async function generarKek(
  opts: OpcionesKekGenerar,
  deps: DepsKekGenerar = {},
): Promise<ResultadoKekGenerar> {
  const log = deps.log ?? (() => {});
  const salida = resolverRuta(opts.salida);
  const rutaPublica = join(salida, "kek-public.pem");
  const rutaPrivada = join(salida, "kek-private.pem");
  // Perder la privada pierde todas las credenciales: nunca se pisa un par existente.
  if (existsSync(rutaPublica) || existsSync(rutaPrivada)) {
    throw new Error(
      "Ya existe una llave en la carpeta de salida; kek:generar no sobrescribe.",
    );
  }
  exigirSalidaIgnorada(salida);
  await mkdir(salida, { recursive: true });
  const { publicKey, privateKey } = await generarPar("rsa", {
    modulusLength: MODULO_MINIMO,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await writeFile(rutaPrivada, privateKey, { mode: 0o600, flag: "wx" });
  await chmod(rutaPrivada, 0o600);
  await writeFile(rutaPublica, publicKey, { mode: 0o644, flag: "wx" });
  await chmod(rutaPublica, 0o644);
  const huella = huellaSpki(createPublicKey(publicKey));
  log(`Llave pública: ${rutaPublica}`);
  log(`Llave privada: ${rutaPrivada}`);
  log(`Huella SHA-256 (SPKI): ${huella}`);
  return { rutaPublica, rutaPrivada, huella };
}

/** `kek:generar [--salida <carpeta>]`; las rutas relativas son relativas a la raíz del repo. */
export async function main(
  argv: string[],
  deps: DepsKekGenerar = {},
): Promise<void> {
  const args = argv.filter((a) => a !== "--");
  let salida = SALIDA_POR_DEFECTO;
  for (let i = 0; i < args.length; i += 1) {
    const valor = args[i + 1];
    if (args[i] !== "--salida" || valor === undefined) {
      throw new Error("Uso: kek:generar [--salida <carpeta>]");
    }
    salida = valor;
    i += 1;
  }
  const log =
    deps.log ?? ((linea: string) => process.stdout.write(`${linea}\n`));
  await generarKek({ salida }, { log });
}

/** Punto de entrada del proceso: devuelve el código de salida sin volcar nada más que el mensaje. */
export async function ejecutar(
  argv: string[],
  deps: DepsKekGenerar & { error?: (linea: string) => void } = {},
): Promise<number> {
  try {
    await main(argv, deps);
    return 0;
  } catch (e) {
    const error =
      deps.error ?? ((linea: string) => process.stderr.write(`${linea}\n`));
    error(`kek:generar: ${(e as Error).message}`);
    return 1;
  }
}

arrancarSiDirecta(require.main, module, ejecutar, process.argv.slice(2));
