import { defineConfig } from "vitest/config";

// Unitarias de @contapp/correo: solo fuentes (src), nunca dist. Sin BD ni red.
export default defineConfig({
  test: {
    reporters: ["dot"],
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
