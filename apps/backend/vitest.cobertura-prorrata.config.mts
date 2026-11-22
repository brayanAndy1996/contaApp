import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 026 (prorrata e IGV estimado, T14): mide el módulo prorrata del backend (lectura, obtener,
// manual, prorrata usada, IGV de compras, servicios, escritura y apoyo) con sus pruebas de integración
// contra BD, las de permisos y rendimiento de modules/prorrata/, y la suite HTTP de 026 que ejercita las
// mismas rutas (aislamiento/hu40-api.int.spec.ts, T6). Umbral de 90 % por archivo.
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
      "apps/backend/src/modules/prorrata/**/*.spec.ts",
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
      include: ["apps/backend/src/modules/prorrata/*.ts"],
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
