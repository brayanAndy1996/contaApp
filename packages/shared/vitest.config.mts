import { defineConfig } from "vitest/config";

// Unitarias de @contapp/shared: solo fuentes (src), nunca dist.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
