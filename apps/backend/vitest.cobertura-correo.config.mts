import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura de 028 (avisos por correo y resumen diario, T14): mide el módulo correo del backend
// (apps/backend/src/modules/correo/*.ts: preferencias y baja), el adaptador de correo de infra
// (apps/backend/src/infra/correo/*.ts, que reexporta @contapp/correo y conserva cola.ts) y los archivos de
// guards que 028 modifica (origen.guard.ts con @SinOrigen() y decoradores.ts), con sus pruebas unitarias y de
// integración contra BD (modules/correo, infra/correo y modules/auth/guards). Umbral de 90 % por archivo.
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
      "apps/backend/src/modules/correo/**/*.spec.ts",
      "apps/backend/src/infra/correo/**/*.spec.ts",
      "apps/backend/src/modules/auth/guards/*.spec.ts",
    ],
    exclude: ["**/node_modules/**"],
    // Las suites con BD comparten la misma base: nada en paralelo.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Bajo cobertura las pruebas de tiempo corren sin comparar (ver test/tiempos.ts).
    env: { CONTAPP_COBERTURA: "1" },
    coverage: {
      provider: "v8",
      include: [
        "apps/backend/src/modules/correo/*.ts",
        "apps/backend/src/infra/correo/*.ts",
        "apps/backend/src/modules/auth/guards/origen.guard.ts",
        "apps/backend/src/modules/auth/guards/decoradores.ts",
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
