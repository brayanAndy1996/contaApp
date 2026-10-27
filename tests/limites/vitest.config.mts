import { defineConfig } from "vitest/config";

// Las pruebas de lint arrancan ESLint en frío (primera prueba de cada archivo): bajo la carga
// de `turbo run test` (suites en paralelo) superan los 5 s por defecto sin fallar ninguna aserción.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
