import { defineConfig } from "vitest/config";

// Cobertura de 025 (aprendizaje de arranque, T14): mide src/mock/sire-api-client.mock.ts (SIRE falso,
// incluido el registro presentado) con las pruebas unitarias de sunat, sin *.int.spec.ts (sin BD ni
// Redis). Umbral de 90 % por archivo.
// Tiempos de 30 s como en domain: con instrumentación v8 en el runner de CI las propiedades de
// fast-check superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/*.int.spec.ts", "**/*.contrato.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/mock/sire-api-client.mock.ts"],
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
