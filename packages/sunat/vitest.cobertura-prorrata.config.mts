import { defineConfig } from "vitest/config";

// Cobertura de 026 (prorrata e IGV estimado, T14): mide src/mock/sol-portal.mock.ts (SOL falso, con el
// PDT 621 y sus fixtures) con las pruebas unitarias de sunat (sol-portal*.spec.ts), sin *.int.spec.ts
// (sin BD ni Redis). Umbral de 90 % por archivo.
// Tiempos de 30 s como en domain: con instrumentación v8 en el runner de CI las propiedades de
// fast-check superan los 5 s por defecto sin fallar aserciones.
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
