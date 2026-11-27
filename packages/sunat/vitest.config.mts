import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Patrón de la prueba de contrato del SIRE (041, CA-15): nunca corre en `test` ni en `test:int`.
export const patronContrato = "**/*.contrato.spec.ts";

// `vitest run`: unitarias sin BD ni Redis (*.spec.ts). `vitest run --mode int` (script test:int):
// solo *.int.spec.ts, en un hilo, con ../../.env y luego ./.env si existen.
// `vitest run --mode contrato` (script test:contrato): solo *.contrato.spec.ts, con los mismos .env,
// y solo con SIRE_CONTRATO=1; sin esa variable no se carga ningún archivo ni corre ninguna prueba.
export function filtrosDeModo(mode: string, env: Record<string, string | undefined>) {
  if (mode === "int") {
    return {
      include: ["src/**/*.int.spec.ts"],
      exclude: ["**/node_modules/**", patronContrato],
    };
  }
  if (mode === "contrato") {
    return {
      include: env.SIRE_CONTRATO === "1" ? ["src/**/*.contrato.spec.ts"] : [],
      exclude: ["**/node_modules/**"],
    };
  }
  return {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/*.int.spec.ts", patronContrato],
  };
}

export default defineConfig(({ mode }) => {
  const integracion = mode === "int";
  if (integracion || mode === "contrato") {
    for (const archivo of ["../../.env", "./.env"]) {
      if (existsSync(archivo)) process.loadEnvFile(archivo);
    }
  }
  return {
    test: {
      reporters: ["dot"],
      ...filtrosDeModo(mode, process.env),
      fileParallelism: !integracion,
      testTimeout: 30_000,
    },
  };
});
