// Resolución de rutas de llaves. Las relativas (`./secrets/...`) se resuelven contra la raíz del
// repo (donde está pnpm-workspace.yaml), no contra el cwd: `pnpm --filter` cambia el cwd al paquete.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MARCA_RAIZ = "pnpm-workspace.yaml";

/** Sube desde `desde` hasta encontrar la raíz del monorepo; si no hay, usa el cwd. */
export function raizRepo(desde: string = __dirname): string {
  let actual = resolve(desde);
  for (;;) {
    if (existsSync(join(actual, MARCA_RAIZ))) return actual;
    const padre = dirname(actual);
    if (padre === actual) return process.cwd();
    actual = padre;
  }
}

export function resolverRuta(ruta: string, raiz: string = raizRepo()): string {
  return isAbsolute(ruta) ? ruta : resolve(raiz, ruta);
}
