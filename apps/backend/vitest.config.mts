import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// `vitest run`: unitarias sin BD (*.spec.ts). `vitest run --mode int` (script test:int):
// solo *.int.spec.ts, en un hilo, con ../../.env y luego ./.env si existen.
export default defineConfig(({ mode }) => {
  const integracion = mode === "int";
  if (integracion) {
    for (const archivo of ["../../.env", "./.env"]) {
      if (existsSync(archivo)) process.loadEnvFile(archivo);
    }
    // 029 (D1): `TOTP_CLAVE` es obligatoria para arrancar; sin una en el entorno, las pruebas usan una efímera.
    process.env.TOTP_CLAVE ??= `1:${randomBytes(32).toString("base64")}`;
  }
  return {
    test: {
      reporters: ["dot"],
      include: integracion ? ["src/**/*.int.spec.ts"] : ["src/**/*.spec.ts"],
      exclude: integracion
        ? ["**/node_modules/**"]
        : ["**/node_modules/**", "**/*.int.spec.ts"],
      fileParallelism: !integracion,
    },
  };
});
