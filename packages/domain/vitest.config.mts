import { defineConfig } from "vitest/config";

// Unitarias de @contapp/domain: lógica pura, sin BD ni red.
// testTimeout holgado: bajo la carga de `turbo run test` (suites en paralelo) alguna prueba
// pesada supera los 5 s por defecto sin fallar ninguna aserción.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts", "tests/**/*.spec.ts"],
    testTimeout: 30_000,
  },
});
