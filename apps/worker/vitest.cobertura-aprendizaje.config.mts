import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 025 (aprendizaje de arranque, T14): mide la importación del historial
// (procesadores/importar-historial.ts) y el perfil y las reglas de compras (persistidores/
// compras-std.ts) con todas las suites de trabajos en un solo run, unitarias y de integración.
// Las cierre-*.adv.int.spec.ts van en ci:cierre, aparte. Umbral de 90 % por archivo.
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
    env,
  },
});

const sinInt = ["**/node_modules/**", "**/*.int.spec.ts"];

export default defineConfig({
  root: raiz,
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    // Sin --passWithNoTests: "sin pruebas" debe fallar.
    projects: [
      proyecto(
        "worker-aprendizaje-unit",
        ["apps/worker/src/trabajos/**/*.spec.ts"],
        sinInt,
      ),
      proyecto(
        "worker-aprendizaje-int",
        ["apps/worker/src/trabajos/**/*.int.spec.ts"],
        ["**/node_modules/**", "**/cierre-*.adv.int.spec.ts"],
        { CONTAPP_COBERTURA: "1" },
      ),
    ],
    coverage: {
      provider: "v8",
      include: [
        "apps/worker/src/trabajos/procesadores/importar-historial.ts",
        "apps/worker/src/trabajos/persistidores/compras-std.ts",
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
