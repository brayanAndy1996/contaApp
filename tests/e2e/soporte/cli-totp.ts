// `pnpm db:totp-restablecer --correo <correo>` desde la prueba (spec 029, T11, U5): el operador restablece el TOTP de un
// usuario. Corre el CLI ya compilado (`packages/db/dist/cli`, lo deja `pnpm e2e:build`) con el entorno de la pila: la BD de
// la E2E y el mismo correo (Mailpit o consola) que usan el backend y el worker. La salida es una línea fija: no se imprime.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { RAIZ, entornoDeLaPila, leerConfig } from "./pila/entorno.js";

export function restablecerTotp(correo: string): Promise<void> {
  const dir = process.env.E2E_PILA_DIR;
  if (dir === undefined)
    return Promise.reject(
      new Error("No hay pila E2E en marcha (falta E2E_PILA_DIR)."),
    );
  const env = entornoDeLaPila(leerConfig(), dir);
  return new Promise((resolver, rechazar) => {
    execFile(
      process.execPath,
      [
        join(RAIZ, "packages/db/dist/cli/totp-restablecer.js"),
        "--correo",
        correo,
      ],
      { cwd: join(RAIZ, "packages/db"), env, maxBuffer: 1024 * 1024 },
      (error) => {
        if (error === null) resolver();
        else
          rechazar(
            new Error(
              `db:totp-restablecer falló (código ${String(error.code ?? "?")}).`,
            ),
          );
      },
    );
  });
}
