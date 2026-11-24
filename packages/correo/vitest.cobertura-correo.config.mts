import { defineConfig } from "vitest/config";

// Cobertura de 028 (avisos por correo y resumen diario, T14): mide packages/correo/src/*.ts (puerto, consola,
// memoria, SMTP y fábrica) con todas sus pruebas unitarias (sin BD ni red). Umbral de 90 % por archivo.
// `index.ts` solo reexporta.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/*.ts"],
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
