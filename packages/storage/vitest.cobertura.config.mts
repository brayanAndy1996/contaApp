import { defineConfig } from "vitest/config";

// Cobertura de 016 (almacenamiento de XML): mide src/** con las mismas pruebas que
// vitest.config.mts, sin servicios. Umbral de 90 % por archivo.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.spec.ts", "**/*.adv.spec.ts"],
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
