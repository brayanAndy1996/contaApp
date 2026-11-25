import { defineConfig } from "vitest/config";

// Cobertura de 028 (avisos por correo y resumen diario, T14): mide src/correo/*.ts (aviso, comun, errores,
// pendientes, resumen, texto, tiempo y validacion) con sus pruebas: src/correo/ (todas, incluida la de
// propiedades) y la adversarial de la ronda 2b (src/ronda2b.adv.spec.ts, que ejerce el escapado y el saneo).
// Umbral de 90 % por archivo.
// testTimeout igual que vitest.cobertura-gastos.config.mts: con instrumentación v8 las propiedades de
// fast-check superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: ["src/correo/**/*.spec.ts", "src/ronda2b.adv.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/correo/*.ts"],
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
