import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// `vitest run`: unitarias sin BD (*.spec.ts). `vitest run --mode int` (script test:int):
// solo *.int.spec.ts, en un hilo, con ../../.env y luego ./.env si existen.
// Spec 009 (D18, T8): las 3 pruebas de cierre de 008 no corren en test:int. Solo con CIERRE_APARTE=1
// (script test:int:cierre, paso aparte de ci:cierre): solo esos archivos, con un único worker de vitest.
const CIERRE_APARTE_GLOB = "src/trabajos/cierre-*.adv.int.spec.ts";

export default defineConfig(({ mode }) => {
  const integracion = mode === "int";
  const cierreAparte = process.env.CIERRE_APARTE === "1";
  if (integracion) {
    for (const archivo of ["../../.env", "./.env"]) {
      if (existsSync(archivo)) process.loadEnvFile(archivo);
    }
  }
  return {
    test: {
      include: integracion
        ? [cierreAparte ? CIERRE_APARTE_GLOB : "src/**/*.int.spec.ts"]
        : ["src/**/*.spec.ts"],
      exclude: integracion
        ? ["**/node_modules/**", ...(cierreAparte ? [] : [CIERRE_APARTE_GLOB])]
        : ["**/node_modules/**", "**/*.int.spec.ts"],
      fileParallelism: !integracion,
      ...(cierreAparte ? { maxWorkers: 1 } : {}),
    },
  };
});
