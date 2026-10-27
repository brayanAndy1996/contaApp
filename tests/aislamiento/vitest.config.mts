import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Carga el .env del repo si existe.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  test: {
    include: ["**/*.spec.ts"],
    // Un solo hilo: las suites comparten la misma base de datos.
    fileParallelism: false,
  },
});
