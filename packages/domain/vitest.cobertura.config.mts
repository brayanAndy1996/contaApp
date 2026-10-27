import { defineConfig } from "vitest/config";

// Cobertura de 010 (DoD A): mide dinero/ y comprobante/ con las mismas
// pruebas que vitest.config.mts. Umbral de 90 % por archivo.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts", "tests/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      include: ["src/dinero/**/*.ts", "src/comprobante/**/*.ts"],
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
