import { defineConfig } from "vitest/config";

// Cobertura de 012 (CA-11): mide src/formatos/ con las pruebas unitarias de
// vitest.config.mts, sin *.int.spec.ts (sin BD ni Redis, D9). Umbral de 90 % por
// archivo.
// Tiempos de 30 s como en domain: con instrumentación v8 en el runner de CI las
// propiedades de fast-check (1000 corridas) superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/*.int.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/formatos/**/*.ts"],
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
