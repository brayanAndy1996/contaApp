import { defineConfig } from "vitest/config";

// Cobertura de 010 (DoD A), 011 (CA-13), 012 (CA-11) y 013 (T9): mide dinero/, comprobante/,
// reglas/, texto/, prevalidacion/, formatos/, clave-comprobante/, correlatividad/, complemento/
// y ventas/ con las mismas pruebas que
// vitest.config.mts. Umbral de 90 % por archivo.
// testTimeout igual que vitest.config.mts: con instrumentación v8 en el runner de CI las
// propiedades de fast-check (1000 corridas) superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts", "tests/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: [
        "src/dinero/**/*.ts",
        "src/comprobante/**/*.ts",
        "src/reglas/**/*.ts",
        "src/texto/**/*.ts",
        "src/prevalidacion/**/*.ts",
        "src/formatos/**/*.ts",
        "src/clave-comprobante/**/*.ts",
        "src/correlatividad/**/*.ts",
        "src/complemento/**/*.ts",
        "src/ventas/**/*.ts",
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
