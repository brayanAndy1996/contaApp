import { defineConfig } from "vitest/config";

// Unitarias de @contapp/domain: lógica pura, sin BD ni red.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts", "tests/**/*.spec.ts"],
  },
});
