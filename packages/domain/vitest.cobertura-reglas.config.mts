import { defineConfig } from "vitest/config";

// Cobertura de 021 (reglas aprendidas, T15): mide src/reglas/ (R-HIS, catálogo y motor de reglas)
// con sus pruebas unitarias, las adversariales incluidas. Umbral de 90 % por archivo.
// testTimeout igual que vitest.cobertura.config.mts: con instrumentación v8 las propiedades de
// fast-check superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: ["src/reglas/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/reglas/**/*.ts"],
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
