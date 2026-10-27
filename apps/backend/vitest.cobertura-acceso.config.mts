import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 005 (DoD A): mide guards, acceso y clientes del backend, lo que
// 005 agrega en packages/db y packages/shared, con todas las suites en un run.
const raiz = fileURLToPath(new URL("../..", import.meta.url));
const ruta = (relativa: string) =>
  fileURLToPath(new URL(relativa, import.meta.url));

// Carga el .env del repo y el del backend si existen.
for (const archivo of [ruta("../../.env"), ruta("./.env")]) {
  if (existsSync(archivo)) {
    process.loadEnvFile(archivo);
  }
}

// Los paquetes se importan desde la fuente para que cuenten en cobertura.
const alias = [
  { find: "@contapp/db", replacement: ruta("../../packages/db/src/index.ts") },
  {
    find: "@contapp/shared",
    replacement: ruta("../../packages/shared/src/index.ts"),
  },
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
  },
});

export default defineConfig({
  root: raiz,
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    // Sin --passWithNoTests: "sin pruebas" debe fallar.
    projects: [
      proyecto(
        "backend-unit",
        ["apps/backend/src/**/*.spec.ts"],
        ["**/node_modules/**", "**/*.int.spec.ts"],
      ),
      proyecto("backend-int", ["apps/backend/src/**/*.int.spec.ts"]),
      proyecto("aislamiento-acceso", ["tests/aislamiento/acceso*.spec.ts"]),
      proyecto("shared-acceso", ["packages/shared/src/acceso/**/*.spec.ts"]),
      proyecto("db-acceso", [
        "packages/db/src/acceso/**/*.spec.ts",
        "packages/db/src/auth/**/*.spec.ts",
      ]),
    ],
    coverage: {
      provider: "v8",
      include: [
        "apps/backend/src/modules/acceso/**/*.ts",
        "apps/backend/src/modules/clientes/**/*.ts",
        "apps/backend/src/modules/auth/guards/**/*.ts",
        "apps/backend/src/modules/estudio/**/*.ts",
        "packages/db/src/acceso/**/*.ts",
        "packages/db/src/auth/**/*.ts",
        "packages/shared/src/acceso/**/*.ts",
      ],
      exclude: ["**/*.spec.ts", "**/*.adv.spec.ts", "**/*.int.spec.ts"],
      reporter: ["text", "html"],
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
