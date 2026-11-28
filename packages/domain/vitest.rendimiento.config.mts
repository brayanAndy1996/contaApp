import { defineConfig } from "vitest/config";

// Rendimiento de @contapp/domain (027 CA-15): razones de tiempo entre dos medidas. Corre sola y en serie
// (un solo worker): en paralelo con el resto de suites, la carga del runner la hacía fallar.
// Standalone a propósito: mergeConfig concatenaría los `exclude` de vitest.config.mts y dejaría fuera este spec.
export default defineConfig({
  test: {
    reporters: ["dot"],
    include: ["**/*.rendimiento.spec.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
