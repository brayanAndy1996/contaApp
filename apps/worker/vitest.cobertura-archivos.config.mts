import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 012b (generar el archivo SIRE, DoD A): mide el procesador archivo.generar
// (generar-archivo.ts) con sus pruebas unitarias y de integración en un solo run. Umbral de 90 %
// por archivo.
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

export default defineConfig({
  root: raiz,
  resolve: { alias },
  test: {
    include: ["apps/worker/src/trabajos/procesadores/generar-archivo*.spec.ts"],
    exclude: ["**/node_modules/**"],
    // Las suites con BD y Redis comparten recursos: nada en paralelo.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    // CA-13 (20.000 filas en menos de 5 s) mantiene su límite estricto en `test:int`; bajo la instrumentación de v8 la misma
    // ejecución tarda 5,8 a 6,4 s, así que esta config, y solo ella, relaja el límite a 3 veces (ver `generar-archivo.int.spec.ts`).
    env: { CONTAPP_COBERTURA: "1" },
    coverage: {
      provider: "v8",
      include: ["apps/worker/src/trabajos/procesadores/generar-archivo.ts"],
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
