import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 012b (generar el archivo SIRE, DoD A): mide el módulo archivos (previo, generar,
// versiones y descarga) y el estado y la exclusión de ventas (estado.service.ts y exclusion.service.ts)
// con sus pruebas de integración y las unitarias de las ramas defensivas (T16a) en un solo run. Umbral de 90 % por archivo.
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
      "apps/backend/src/modules/archivos/**/*.spec.ts",
      "apps/backend/src/modules/ventas/estado-periodo.int.spec.ts",
      "apps/backend/src/modules/ventas/estado.service.spec.ts",
      "apps/backend/src/modules/ventas/exclusion.int.spec.ts",
      "apps/backend/src/modules/ventas/exclusion.service.spec.ts",
    ],
    exclude: ["**/node_modules/**"],
    // Las suites con BD y Redis comparten recursos: nada en paralelo.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: [
        "apps/backend/src/modules/archivos/**/*.ts",
        "apps/backend/src/modules/ventas/estado.service.ts",
        "apps/backend/src/modules/ventas/exclusion.service.ts",
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
