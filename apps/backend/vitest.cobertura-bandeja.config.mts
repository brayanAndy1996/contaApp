import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 024 (bandeja de buzones, T10): mide bandeja.controller.ts, bandeja.service.ts,
// atencion.service.ts y cursor.ts del módulo buzon con las pruebas de bandeja, atención, detalle,
// cursor y mapeo (unitarias e integración contra BD). test/soporte-bandeja.ts es soporte de pruebas
// y queda fuera. Umbral de 90 % por archivo.
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
      "apps/backend/src/modules/buzon/atencion.service.spec.ts",
      "apps/backend/src/modules/buzon/atencion.int.spec.ts",
      "apps/backend/src/modules/buzon/bandeja.int.spec.ts",
      "apps/backend/src/modules/buzon/bandeja.rendimiento.int.spec.ts",
      "apps/backend/src/modules/buzon/detalle-atencion.int.spec.ts",
      "apps/backend/src/modules/buzon/cursor.spec.ts",
      "apps/backend/src/modules/buzon/mapeo.spec.ts",
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
      include: [
        "apps/backend/src/modules/buzon/bandeja.controller.ts",
        "apps/backend/src/modules/buzon/bandeja.service.ts",
        "apps/backend/src/modules/buzon/atencion.service.ts",
        "apps/backend/src/modules/buzon/cursor.ts",
      ],
      exclude: [
        "**/*.spec.ts",
        "**/*.adv.spec.ts",
        "**/*.int.spec.ts",
        "**/*.adv.int.spec.ts",
        "apps/backend/test/soporte-bandeja.ts",
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
