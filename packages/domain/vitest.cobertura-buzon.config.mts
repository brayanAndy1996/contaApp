import { defineConfig } from "vitest/config";

// Cobertura de 023 (buzones, T15): mide src/buzon/ (captura, clasificación, programación,
// normalización, adjuntos y texto plano) con sus pruebas unitarias. Umbral de 90 % por archivo.
// testTimeout igual que vitest.cobertura-reglas.config.mts: con instrumentación v8 las propiedades
// de fast-check superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: ["src/buzon/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/buzon/**/*.ts"],
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
