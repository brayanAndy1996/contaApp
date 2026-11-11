import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 017 (T14, DoD): mide el registro y el ejecutor de trabajos, el notificador del worker y el
// publicador de avisos de queue (eventos.ts) con sus pruebas unitarias y de integración en un solo run.
// Umbral de 90 % por archivo.
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
    include: [
      "apps/worker/src/trabajos/registro*.spec.ts",
      "apps/worker/src/trabajos/ejecutor*.spec.ts",
      "apps/worker/src/trabajos/notificador*.spec.ts",
      "packages/queue/src/eventos*.spec.ts",
    ],
    exclude: ["**/node_modules/**"],
    // Las suites con BD y Redis comparten recursos: nada en paralelo.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: [
        "apps/worker/src/trabajos/registro.ts",
        "apps/worker/src/trabajos/ejecutor.ts",
        "apps/worker/src/trabajos/notificador.ts",
        "packages/queue/src/eventos.ts",
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
