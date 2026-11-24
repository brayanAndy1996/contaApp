import { defineConfig } from "vitest/config";

// Cobertura de 027 (gastos no deducibles, T14): mide src/gastos/*.ts (contexto, categorías, matriz,
// puntaje, términos, feriados y CIIU), src/texto/diccionario.ts y src/reglas/r-gp.ts con sus pruebas
// unitarias: src/gastos/ (todas), src/texto/diccionario*.spec.ts y src/reglas/r-gp*.spec.ts.
// Umbral de 90 % por archivo.
// testTimeout igual que vitest.cobertura-prorrata.config.mts: con instrumentación v8 las propiedades de
// fast-check superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: [
      "src/gastos/**/*.spec.ts",
      "src/texto/diccionario*.spec.ts",
      "src/reglas/r-gp*.spec.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: [
        "src/gastos/*.ts",
        "src/texto/diccionario.ts",
        "src/reglas/r-gp.ts",
      ],
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
