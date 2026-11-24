import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 028 (avisos por correo y resumen diario, T14): mide packages/db/src/correo/*.ts (preferencias,
// envíos, resumen, ciclo y baja) y packages/db/src/auth/repositorio.ts (`aplicarBaja` y el resto del archivo,
// que 028 modifica) con las pruebas unitarias de BD de src/correo/*.spec.ts y src/auth/*.spec.ts, y las
// suites de aislamiento de 028 (tests/aislamiento/correo-*.spec.ts) y de autenticación
// (tests/aislamiento/auth*.spec.ts). Los *.rendimiento*.spec.ts quedan fuera (miden tiempos, no ramas).
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
  exclude: string[] = ["**/node_modules/**", "**/*.rendimiento*.spec.ts"],
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
      proyecto("db-correo-unitarias", [
        "packages/db/src/correo/*.spec.ts",
        "packages/db/src/auth/*.spec.ts",
      ]),
      proyecto("aislamiento-correo", [
        "tests/aislamiento/correo-*.spec.ts",
        "tests/aislamiento/auth*.spec.ts",
      ]),
    ],
    coverage: {
      provider: "v8",
      include: [
        "packages/db/src/correo/*.ts",
        "packages/db/src/auth/repositorio.ts",
      ],
      exclude: [
        "**/*.spec.ts",
        "**/*.adv.spec.ts",
        "**/*.int.spec.ts",
        "**/*.adv.int.spec.ts",
        // Soporte de pruebas (arnés de BD), no producción: como en la cobertura de gastos.
        "packages/db/src/correo/soporte-prueba.ts",
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
