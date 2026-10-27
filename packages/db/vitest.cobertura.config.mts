import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Carga el .env del repo si existe.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const fuente = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const aislamiento = fileURLToPath(
  new URL("../../tests/aislamiento", import.meta.url),
);

export default defineConfig({
  test: {
    // Las suites con BD comparten la misma base: nada en paralelo.
    fileParallelism: false,
    maxWorkers: 1,
    projects: [
      {
        test: {
          name: "unitarias",
          include: ["src/**/*.spec.ts"],
          exclude: ["**/node_modules/**", "**/*.int.spec.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "integracion",
          include: ["src/cli/**/*.int.spec.ts"],
          fileParallelism: false,
        },
      },
      {
        // @contapp/db se importa desde la fuente para que cuente en cobertura.
        resolve: { alias: { "@contapp/db": fuente } },
        test: {
          name: "aislamiento",
          root: aislamiento,
          include: ["**/*.spec.ts"],
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.spec.ts", "**/*.adv.spec.ts", "**/*.int.spec.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
