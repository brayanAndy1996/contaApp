import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// `vitest run`: unitarias sin BD ni Redis (*.spec.ts). `vitest run --mode int` (script test:int):
// solo *.int.spec.ts, en un hilo, con ../../.env y luego ./.env si existen.
export default defineConfig(({ mode }) => {
  const integracion = mode === "int";
  if (integracion) {
    for (const archivo of ["../../.env", "./.env"]) {
      if (existsSync(archivo)) process.loadEnvFile(archivo);
    }
  }
  return {
    test: {
      include: integracion ? ["src/**/*.int.spec.ts"] : ["src/**/*.spec.ts"],
      exclude: integracion
        ? ["**/node_modules/**"]
        : ["**/node_modules/**", "**/*.int.spec.ts"],
      fileParallelism: !integracion,
      testTimeout: 30_000,
    },
  };
});
