import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 028 (avisos por correo y resumen diario, T14): mide los procesadores programar-correo.ts y
// enviar-correo.ts y los archivos previos que 028 modifica en el worker (auth-purgar.ts: purga de envíos y
// preferencias; adaptadores.module.ts: Correo y APP_ORIGIN; iniciar.ts: procesador y tick de correo;
// ejecutor.ts y trabajos.module.ts) con sus pruebas unitarias (ramas), de integración contra BD y Redis y las
// del arranque (iniciar, sistema, módulo y su cierre con tope). Los *.rendimiento*.spec.ts quedan fuera (miden tiempos, no ramas).
// Umbral de 90 % por archivo.
const raiz = fileURLToPath(new URL("../..", import.meta.url));
const ruta = (relativa: string) =>
  fileURLToPath(new URL(relativa, import.meta.url));

// Carga el .env del repo y el del worker si existen.
for (const archivo of [ruta("../../.env"), ruta("./.env")]) {
  if (existsSync(archivo)) {
    process.loadEnvFile(archivo);
  }
}

// Los paquetes se importan desde la fuente para que cuenten en cobertura.
// `@contapp/queue/worker` va antes que `@contapp/queue` (coincidencia por expresión exacta).
const alias = [
  { find: "@contapp/db", replacement: ruta("../../packages/db/src/index.ts") },
  {
    find: "@contapp/shared",
    replacement: ruta("../../packages/shared/src/index.ts"),
  },
  {
    find: "@contapp/sunat",
    replacement: ruta("../../packages/sunat/src/index.ts"),
  },
  {
    find: /^@contapp\/queue\/worker$/,
    replacement: ruta("../../packages/queue/src/worker/index.ts"),
  },
  {
    find: /^@contapp\/queue$/,
    replacement: ruta("../../packages/queue/src/index.ts"),
  },
];

const proyecto = (
  name: string,
  include: string[],
  exclude: string[] = ["**/node_modules/**"],
  env: Record<string, string> = {},
) => ({
  resolve: { alias },
  test: {
    name,
    root: raiz,
    include,
    exclude,
    // Las suites con BD y Redis comparten recursos: nada en paralelo.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env,
  },
});

const sinInt = ["**/node_modules/**", "**/*.int.spec.ts"];
const sinRendimiento = ["**/node_modules/**", "**/*.rendimiento*.spec.ts"];

export default defineConfig({
  root: raiz,
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    // Sin --passWithNoTests: "sin pruebas" debe fallar.
    projects: [
      proyecto(
        "worker-correo-unit",
        [
          "apps/worker/src/trabajos/procesadores/programar-correo*.spec.ts",
          "apps/worker/src/trabajos/procesadores/enviar-correo*.spec.ts",
          "apps/worker/src/trabajos/procesadores/auth-purgar*.spec.ts",
          "apps/worker/src/trabajos/{iniciar,ejecutor,trabajos.module,cierre-t16}*.spec.ts",
          "apps/worker/src/adaptadores/*.spec.ts",
        ],
        sinInt,
      ),
      proyecto(
        "worker-correo-int",
        [
          "apps/worker/src/trabajos/procesadores/programar-correo*.int.spec.ts",
          "apps/worker/src/trabajos/procesadores/enviar-correo*.int.spec.ts",
          "apps/worker/src/trabajos/procesadores/auth-purgar*.int.spec.ts",
          "apps/worker/src/trabajos/sistema.int.spec.ts",
          "apps/worker/src/trabajos/ejecutor*.int.spec.ts",
        ],
        sinRendimiento,
        { CONTAPP_COBERTURA: "1" },
      ),
    ],
    coverage: {
      provider: "v8",
      include: [
        "apps/worker/src/trabajos/procesadores/programar-correo.ts",
        "apps/worker/src/trabajos/procesadores/enviar-correo.ts",
        "apps/worker/src/trabajos/procesadores/auth-purgar.ts",
        "apps/worker/src/adaptadores/adaptadores.module.ts",
        "apps/worker/src/trabajos/iniciar.ts",
        "apps/worker/src/trabajos/ejecutor.ts",
        "apps/worker/src/trabajos/trabajos.module.ts",
      ],
      exclude: [
        "**/*.spec.ts",
        "**/*.adv.spec.ts",
        "**/*.int.spec.ts",
        "**/*.adv.int.spec.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        perFile: true,
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
