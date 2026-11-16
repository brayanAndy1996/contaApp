import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 021 (reglas aprendidas, T15): mide packages/db/src/reglas/ con sus pruebas unitarias
// y con las suites de BD de tests/aislamiento (reglas-*.spec.ts). Estas llegan a la fuente de
// @contapp/db por alias para que cuente en cobertura. Umbral de 90 % por archivo.
const raiz = fileURLToPath(new URL("../..", import.meta.url));
const ruta = (relativa: string) =>
  fileURLToPath(new URL(relativa, import.meta.url));

// Carga el .env del repo y el de db si existen.
for (const archivo of [ruta("../../.env"), ruta("./.env")]) {
  if (existsSync(archivo)) {
    process.loadEnvFile(archivo);
  }
}

// Los paquetes se importan desde la fuente para que cuenten en cobertura.
const alias = [
  { find: "@contapp/db", replacement: ruta("./src/index.ts") },
  { find: "@contapp/shared", replacement: ruta("../shared/src/index.ts") },
];

const proyecto = (
  name: string,
  include: string[],
  exclude: string[] = ["**/node_modules/**"],
) => ({
  resolve: { alias },
  test: {
    name,
    root: raiz,
    include,
    exclude,
    // Las suites con BD comparten la misma base: nada en paralelo.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { CONTAPP_COBERTURA: "1" },
  },
});

export default defineConfig({
  root: raiz,
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    // Sin --passWithNoTests: "sin pruebas" debe fallar.
    projects: [
      proyecto("db-reglas-unitarias", ["packages/db/src/reglas/**/*.spec.ts"]),
      proyecto("aislamiento-reglas", ["tests/aislamiento/reglas-*.spec.ts"]),
    ],
    coverage: {
      provider: "v8",
      include: ["packages/db/src/reglas/**/*.ts"],
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
