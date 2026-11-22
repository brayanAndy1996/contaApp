import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 027 (gastos no deducibles, T14): mide packages/db/src/gastos/*.ts y
// packages/db/src/xml/reevaluar.ts (reevaluarCompra) con sus pruebas unitarias de BD
// (packages/db/src/gastos/*.spec.ts), las suites de aislamiento de 027 (tests/aislamiento/gnd-*.spec.ts)
// y las suites de compras-xml que ejercen reevaluarCompra y reevaluarComprobante (comprobante, concurrencia, evaluación, ronda 2 y R2).
// Umbral de 90 % por archivo.
const raiz = fileURLToPath(new URL("../..", import.meta.url));
const ruta = (relativa: string) =>
  fileURLToPath(new URL(relativa, import.meta.url));

// Carga el .env del repo y el de db si existen.
for (const archivo of [ruta("../../.env"), ruta("./.env")]) {
  if (existsSync(archivo)) {
    process.loadEnvFile(archivo);
  }
}

// Los paquetes se importan desde la fuente para que cuenten en cobertura.
const alias = [
  { find: "@contapp/db", replacement: ruta("./src/index.ts") },
  { find: "@contapp/shared", replacement: ruta("../shared/src/index.ts") },
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
    hookTimeout: 30_000,
    env: { CONTAPP_COBERTURA: "1" },
  },
});

export default defineConfig({
  root: raiz,
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    // Sin --passWithNoTests: "sin pruebas" debe fallar.
    projects: [
      proyecto("db-gastos-unitarias", ["packages/db/src/gastos/*.spec.ts"]),
      proyecto("aislamiento-gastos", [
        "tests/aislamiento/gnd-*.spec.ts",
        "tests/aislamiento/compras-xml-comprobante.spec.ts",
        "tests/aislamiento/compras-xml-concurrencia.spec.ts",
        "tests/aislamiento/compras-xml-evaluacion.spec.ts",
        "tests/aislamiento/compras-xml-ronda2.spec.ts",
        "tests/aislamiento/compras-xml-r2.adv.spec.ts",
      ]),
    ],
    coverage: {
      provider: "v8",
      include: [
        "packages/db/src/gastos/*.ts",
        "packages/db/src/xml/reevaluar.ts",
      ],
      exclude: [
        "**/*.spec.ts",
        "**/*.adv.spec.ts",
        "**/*.int.spec.ts",
        "**/*.adv.int.spec.ts",
        // Soporte de pruebas (arnés de BD), no producción: como en la cobertura de prorrata.
        "packages/db/src/gastos/soporte-prueba.ts",
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
