import { defineConfig } from "vitest/config";

// Cobertura de 023 (buzones, T15): mide el mock del portal SOL del buzón
// (src/mock/sol-portal.mock.ts) con sus pruebas unitarias. Va aparte de
// vitest.cobertura.config.mts, que sigue midiendo src/formatos/ (CA-11 de 012).
// Sin *.int.spec.ts (sin BD ni Redis). Umbral de 90 % por archivo.
// Tiempos de 30 s como en el resto de configs de cobertura (instrumentación v8).
export default defineConfig({
  test: {
    include: ["src/mock/sol-portal*.spec.ts"],
    exclude: ["**/node_modules/**", "**/*.int.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/mock/sol-portal.mock.ts"],
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
