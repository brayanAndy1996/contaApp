import { defineConfig } from "vitest/config";

// Unitarias sin BD. Las de integración (*.int.spec.ts) las corre
// `pnpm cobertura:db` con vitest.cobertura.config.mts.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/*.int.spec.ts"],
  },
});
