import { defineConfig } from "vitest/config";

// Cobertura de 028 (avisos por correo y resumen diario, T14): mide packages/shared/src/correo/*.ts
// (esquemas, vistas y errores) y src/auditoria/acciones.ts (acción del cambio de preferencias y de la baja)
// con las pruebas de src/correo/ y de src/auditoria/. Umbral de 90 % por archivo.
export default defineConfig({
  test: {
    include: ["src/correo/**/*.spec.ts", "src/auditoria/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/correo/*.ts", "src/auditoria/acciones.ts"],
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
