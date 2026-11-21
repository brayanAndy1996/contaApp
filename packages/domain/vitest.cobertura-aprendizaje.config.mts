import { defineConfig } from "vitest/config";

// Cobertura de 025 (aprendizaje de arranque, T14): mide reglas/aprender.ts y reglas/r-std.ts con las
// pruebas de src/reglas/ (021 y 025) y las de R-STD en compras (evaluar-std). Umbral de 90 % por
// archivo.
// testTimeout igual que vitest.cobertura-reglas.config.mts: con instrumentación v8 las propiedades de
// fast-check superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: ["src/reglas/**/*.spec.ts", "src/compras/evaluar-std.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/reglas/aprender.ts", "src/reglas/r-std.ts"],
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
