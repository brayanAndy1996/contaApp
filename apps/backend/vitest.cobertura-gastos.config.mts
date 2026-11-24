import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 027 (gastos no deducibles, T14): mide el módulo gastos del backend
// (apps/backend/src/modules/gastos/*.ts) con sus pruebas de integración contra BD (modules/gastos/*.spec.ts:
// contexto, diccionario, aprendizaje, categorías, plataforma, reevaluación y permisos) y la suite HTTP de
// 027 que ejercita las mismas rutas (aislamiento/hu40-api.int.spec.ts). Umbral de 90 % por archivo.
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

export default defineConfig({
  root: raiz,
  resolve: { alias },
  test: {
    include: [
      "apps/backend/src/modules/gastos/**/*.spec.ts",
      "apps/backend/src/aislamiento/hu40-api.int.spec.ts",
    ],
    exclude: ["**/node_modules/**"],
    // Las suites con BD comparten la misma base: nada en paralelo.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    // Bajo cobertura las pruebas de tiempo corren sin comparar (ver test/tiempos.ts).
    env: { CONTAPP_COBERTURA: "1" },
    coverage: {
      provider: "v8",
      include: ["apps/backend/src/modules/gastos/*.ts"],
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
