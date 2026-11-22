import { defineConfig } from "vitest/config";

// Cobertura de 026 (prorrata e IGV estimado, T14): mide src/prorrata/*.ts (cálculo puro: ventana,
// porcentaje, meses, coeficiente, IGV estimado y diferencia) con las pruebas de src/prorrata/.
// Umbral de 90 % por archivo.
// testTimeout igual que vitest.cobertura-aprendizaje.config.mts: con instrumentación v8 las propiedades
// de fast-check superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: ["src/prorrata/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/prorrata/*.ts"],
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
