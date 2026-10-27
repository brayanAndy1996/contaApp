import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 008 (DoD A): mide la cola, sunat, lo que 008 agrega en db y shared, el worker de
// trabajos y el módulo trabajos del backend, con todas las suites en un solo run.
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
      proyecto("queue-unit", ["packages/queue/src/**/*.spec.ts"], sinInt),
      proyecto("queue-int", ["packages/queue/src/**/*.int.spec.ts"]),
      proyecto("sunat", ["packages/sunat/src/**/*.spec.ts"]),
      proyecto("shared-trabajos", [
        "packages/shared/src/trabajos/**/*.spec.ts",
      ]),
      proyecto("db-trabajos", ["packages/db/src/trabajos/**/*.spec.ts"]),
      proyecto(
        "worker-unit",
        ["apps/worker/src/trabajos/**/*.spec.ts"],
        sinInt,
      ),
      proyecto("worker-int", ["apps/worker/src/trabajos/**/*.int.spec.ts"]),
      proyecto(
        "backend-unit",
        ["apps/backend/src/modules/trabajos/**/*.spec.ts"],
        sinInt,
      ),
      proyecto("backend-int", [
        "apps/backend/src/modules/trabajos/**/*.int.spec.ts",
      ]),
      proyecto("aislamiento-trabajos", ["tests/aislamiento/trabajos*.spec.ts"]),
    ],
    coverage: {
      provider: "v8",
      include: [
        "packages/queue/src/**/*.ts",
        "packages/sunat/src/**/*.ts",
        "packages/db/src/trabajos/**/*.ts",
        "packages/db/src/credenciales/estado.ts",
        "apps/worker/src/trabajos/**/*.ts",
        "apps/backend/src/modules/trabajos/**/*.ts",
        "packages/shared/src/trabajos/**/*.ts",
      ],
      exclude: [
        "**/*.spec.ts",
        "**/*.adv.spec.ts",
        "**/*.int.spec.ts",
        "**/*.adv.int.spec.ts",
        // Dobles de prueba (no son producción ni pruebas): fuera de la medición (plan 008, Ratificaciones (6)).
        "packages/db/src/trabajos/soporte-prueba.ts",
        "packages/queue/src/soporte-pruebas/**",
      ],
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
