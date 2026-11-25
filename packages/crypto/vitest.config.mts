import { defineConfig } from "vitest/config";

// Unitarias de @contapp/crypto: sin BD ni red. Generar un par RSA 4096 tarda
// más que el timeout por defecto, de ahí testTimeout.
export default defineConfig({
  test: {
    reporters: ["dot"],
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 30_000,
  },
});
