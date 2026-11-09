import { defineConfig } from "vitest/config";

// Unitarias de @contapp/storage: sin BD ni red. LocalStorage trabaja con directorios temporales.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**"],
  },
});
