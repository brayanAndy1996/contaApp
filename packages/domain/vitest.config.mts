import { configDefaults, defineConfig } from "vitest/config";

// Unitarias de @contapp/domain: lógica pura, sin BD ni red.
// testTimeout holgado: bajo la carga de `turbo run test` (suites en paralelo) alguna prueba
// pesada supera los 5 s por defecto sin fallar ninguna aserción.
// Las pruebas de rendimiento (`*.rendimiento.spec.ts`) miden razones de tiempo: no van aquí, sino en
// `vitest.rendimiento.config.mts` (script `test:rendimiento`, en serie y fuera de `turbo test`).
export default defineConfig({
  test: {
    reporters: ["dot"],
    include: ["src/**/*.spec.ts", "tests/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.rendimiento.spec.ts"],
    testTimeout: 30_000,
  },
});
