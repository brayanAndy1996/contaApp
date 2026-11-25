import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Cobertura de 028 (avisos por correo y resumen diario, T14): mide los archivos de packages/queue que 028
// modifica (catalogo.ts: NOTIFICACION_ENVIAR y correo.programar; despachador.ts: un trabajo sin cliente no se
// revalida; eventos.ts; worker/index.ts: tick de sistema) con todas las suites del paquete (unitarias y de
// integración contra BD y Redis). Umbral de 90 % por archivo.
// Carga ../../.env y luego ./.env si existen (las int necesitan BD y Redis).
for (const archivo of ["../../.env", "./.env"]) {
  if (existsSync(archivo)) process.loadEnvFile(archivo);
}

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**"],
    // Las suites con BD y Redis comparten recursos: nada en paralelo.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { CONTAPP_COBERTURA: "1" },
    coverage: {
      provider: "v8",
      include: [
        "src/catalogo.ts",
        "src/despachador.ts",
        "src/eventos.ts",
        "src/worker/index.ts",
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
