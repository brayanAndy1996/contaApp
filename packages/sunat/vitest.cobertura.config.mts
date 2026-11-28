import { defineConfig } from "vitest/config";

// Cobertura de 012 (CA-11) y de 041 (T19): mide src/formatos/ y src/http/ (con src/http/txt/) con las
// pruebas unitarias de vitest.config.mts, sin *.int.spec.ts (sin BD ni Redis, D9) y sin
// *.contrato.spec.ts (SUNAT real, 041 CA-15). Un bloque de umbrales por glob medido, como en
// apps/backend y apps/worker: src/formatos/ mantiene 90 % por archivo en las cuatro métricas (012);
// src/http/ exige 90 % agregado del módulo en sentencias y ramas (041).
// Tiempos de 30 s como en domain: con instrumentación v8 en el runner de CI las
// propiedades de fast-check (1000 corridas) superan los 5 s por defecto sin fallar aserciones.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/*.int.spec.ts", "**/*.contrato.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/formatos/**/*.ts", "src/http/**/*.ts", "src/http/txt/**/*.ts"],
      exclude: [
        "**/*.spec.ts",
        "**/*.adv.spec.ts",
        "**/*.contrato.spec.ts",
        // Soporte de pruebas del SIRE (servidor falso, ZIP y TXT de prueba): no es producción.
        "src/http/pruebas/**",
      ],
      reporter: ["text", "json-summary"],
      // Sin umbral global (vitest lo aplicaría a todo lo incluido): cada glob exige lo suyo.
      thresholds: {
        "src/formatos/**/*.ts": {
          perFile: true,
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 90,
        },
        // Agregado del módulo, no por archivo (041): almacen-tickets.ts, almacén en memoria de pruebas,
        // tiene 80 % de ramas y por archivo fallaría.
        "src/http/**/*.ts": {
          statements: 90,
          branches: 90,
        },
      },
    },
  },
});
