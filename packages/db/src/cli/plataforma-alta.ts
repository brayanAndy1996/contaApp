// STUB de T15a (rojo): el CLI `db:plataforma-alta` lo implementa T15b. Contrato fijado por sus pruebas:
//   node dist/cli/plataforma-alta.js --correo <c> [--nombre <n>]      (con MIGRATIONS_DATABASE_URL)
import { ejecutarSiDirecta } from "./comun";

/** Resultado de leer los argumentos del CLI: el correo ya normalizado (trim, minúsculas, NFC, ASCII). */
export interface ArgumentosAlta {
  correo: string;
  nombre?: string;
}

export function parsearArgumentos(argv: readonly string[]): ArgumentosAlta {
  void argv;
  throw new Error("plataforma-alta: no implementado");
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  leerStdin: () => Promise<string> = () => Promise.resolve(""),
): Promise<void> {
  void argv;
  void env;
  void leerStdin;
  throw new Error("plataforma-alta: no implementado");
}

ejecutarSiDirecta(require.main, module, "plataforma-alta", main);
