import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 003 (DoD A): mide packages/crypto, la parte de 003 en packages/db
// y en apps/worker, con las suites de los tres paquetes en un solo run.
const raiz = fileURLToPath(new URL("../..", import.meta.url));
const ruta = (relativa: string) =>
  fileURLToPath(new URL(relativa, import.meta.url));

// Carga el .env del repo y el del worker si existen.
for (const archivo of [ruta("../../.env"), ruta("../../apps/worker/.env")]) {
  if (existsSync(archivo)) {
    process.loadEnvFile(archivo);
  }
}

// Los paquetes se importan desde la fuente para que cuenten en cobertura.
const alias = [
  { find: "@contapp/db", replacement: ruta("../db/src/index.ts") },
  {
    find: "@contapp/crypto/descifrado",
    replacement: ruta("./src/descifrado.ts"),
  },
  { find: "@contapp/crypto", replacement: ruta("./src/index.ts") },
];

export default defineConfig({
  root: raiz,
  test: {
    // Las suites con BD comparten la misma base: nada en paralelo.
    fileParallelism: false,
    maxWorkers: 1,
    // Generar un par RSA 4096 tarda más que el timeout por defecto.
    testTimeout: 30_000,
    projects: [
      {
        resolve: { alias },
        test: {
          name: "crypto",
          root: raiz,
          include: ["packages/crypto/src/**/*.spec.ts"],
          exclude: ["**/node_modules/**"],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "aislamiento-credencial",
          root: raiz,
          include: ["tests/aislamiento/credencial*.spec.ts"],
          exclude: ["**/node_modules/**"],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "worker",
          root: raiz,
          include: ["apps/worker/src/**/*.spec.ts"],
          exclude: ["**/node_modules/**"],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: [
        "packages/crypto/src/**/*.ts",
        "packages/db/src/credenciales/**/*.ts",
        "packages/db/src/schema/credenciales.ts",
        "apps/worker/src/credenciales/**/*.ts",
        "apps/worker/src/cli/kek-rotar.ts",
      ],
      exclude: [
        "**/*.spec.ts",
        "**/*.adv.spec.ts",
        "**/*.int.spec.ts",
        // Helper de pruebas (T5), no es código de producción.
        "packages/crypto/src/soporte-pruebas.ts",
      ],
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
