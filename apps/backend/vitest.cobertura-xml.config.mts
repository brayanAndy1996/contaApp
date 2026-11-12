import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 016 (XML, DoD A): mide el detalle del comprobante, la subida del XML, su descarga y
// «agregar desde XML» del módulo compras (archivos detalle* y *xml*), con todas las suites de compras
// en un solo run. Umbral de 90 % por archivo.
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

const proyecto = (
  name: string,
  include: string[],
  exclude: string[] = ["**/node_modules/**"],
) => ({
  resolve: { alias },
  test: {
    name,
    root: raiz,
    // Spec 020 (P-4): bajo cobertura las pruebas de tiempo corren pero no comparan (lectura CA-15, auth CA-8).
    env: { CONTAPP_COBERTURA: "1" },
    include,
    exclude,
    // Las suites con BD comparten la misma base: nada en paralelo.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

export default defineConfig({
  root: raiz,
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    // Sin --passWithNoTests: "sin pruebas" debe fallar.
    projects: [
      proyecto(
        "compras-unit",
        ["apps/backend/src/modules/compras/**/*.spec.ts"],
        ["**/node_modules/**", "**/*.int.spec.ts"],
      ),
      proyecto("compras-int", [
        "apps/backend/src/modules/compras/**/*.int.spec.ts",
      ]),
    ],
    coverage: {
      provider: "v8",
      include: [
        "apps/backend/src/modules/compras/detalle*.ts",
        "apps/backend/src/modules/compras/*xml*.ts",
      ],
      exclude: ["**/*.spec.ts", "**/*.adv.spec.ts", "**/*.int.spec.ts"],
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
