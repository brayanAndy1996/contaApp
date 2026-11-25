import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura única del worker (spec 042, A1): una sola corrida, con todas las suites de trabajos, mide lo que
// antes medían las 10 configuraciones por spec (008 cola, 012b archivos, 016 XML, 017 auditoría, 021 reglas,
// 023 buzones, 025 aprendizaje, 026 prorrata, 027 gastos y 028 correo).
// Umbral de 90 % por archivo en cada glob de `medidos` (D1: no se baja). Una spec nueva agrega sus globs a
// `medidos` y, si sus suites no entran en un proyecto, el proyecto; no agrega una config ni un paso de CI (A6).
// Las cierre-*.adv.int.spec.ts de 008 van en su paso aparte (ci:cierre) y aquí no se repiten.
const raiz = fileURLToPath(new URL("../..", import.meta.url));
const ruta = (relativa: string) =>
  fileURLToPath(new URL(relativa, import.meta.url));

// Carga el .env del repo y el del worker si existen.
for (const archivo of [ruta("../../.env"), ruta("./.env")]) {
  if (existsSync(archivo)) {
    process.loadEnvFile(archivo);
  }
}

// Los paquetes se importan desde la fuente para que cuenten en cobertura.
// `@contapp/queue/worker` va antes que `@contapp/queue` (coincidencia por expresión exacta).
const alias = [
  { find: "@contapp/db", replacement: ruta("../../packages/db/src/index.ts") },
  {
    find: "@contapp/shared",
    replacement: ruta("../../packages/shared/src/index.ts"),
  },
  {
    find: "@contapp/sunat",
    replacement: ruta("../../packages/sunat/src/index.ts"),
  },
  {
    find: /^@contapp\/queue\/worker$/,
    replacement: ruta("../../packages/queue/src/worker/index.ts"),
  },
  {
    find: /^@contapp\/queue$/,
    replacement: ruta("../../packages/queue/src/index.ts"),
  },
];

const proyecto = (
  name: string,
  include: string[],
  exclude: string[] = ["**/node_modules/**"],
  env: Record<string, string> = {},
) => ({
  resolve: { alias },
  test: {
    name,
    root: raiz,
    include,
    exclude,
    // Las suites con BD y Redis comparten recursos: nada en paralelo.
    fileParallelism: false,
    testTimeout: 30_000,
    env,
  },
});

const sinInt = ["**/node_modules/**", "**/*.int.spec.ts"];

// Lo que se mide: unión de los `coverage.include` de las 10 configuraciones. Los de 012b a 028 (procesadores,
// persistidores, ejecutor, iniciar y trabajos.module) ya caen dentro de `apps/worker/src/trabajos/**`;
// `eventos.ts` de 017, dentro de `packages/queue/src/**`.
const medidos = [
  "packages/queue/src/**/*.ts",
  "packages/sunat/src/**/*.ts",
  "packages/db/src/trabajos/**/*.ts",
  "packages/db/src/credenciales/estado.ts",
  "packages/shared/src/trabajos/**/*.ts",
  "apps/worker/src/trabajos/**/*.ts",
  "apps/worker/src/adaptadores/adaptadores.module.ts",
  "apps/backend/src/modules/trabajos/**/*.ts",
];

// Mismo umbral que tenía cada configuración: 90 % por archivo en las cuatro métricas.
const porArchivo = {
  perFile: true,
  lines: 90,
  statements: 90,
  functions: 90,
  branches: 90,
};

export default defineConfig({
  root: raiz,
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    // Sin --passWithNoTests: "sin pruebas" debe fallar.
    projects: [
      proyecto("queue-unit", ["packages/queue/src/**/*.spec.ts"], sinInt),
      proyecto("queue-int", ["packages/queue/src/**/*.int.spec.ts"]),
      proyecto("sunat", ["packages/sunat/src/**/*.spec.ts"]),
      proyecto("shared-trabajos", [
        "packages/shared/src/trabajos/**/*.spec.ts",
      ]),
      proyecto("db-trabajos", ["packages/db/src/trabajos/**/*.spec.ts"]),
      proyecto(
        "worker-unit",
        [
          "apps/worker/src/trabajos/**/*.spec.ts",
          "apps/worker/src/adaptadores/*.spec.ts",
        ],
        sinInt,
      ),
      // Spec 009 (D18): las pruebas de cierre de 008 van en su paso aparte (ci:cierre) y aquí no se repiten.
      proyecto(
        "worker-int",
        ["apps/worker/src/trabajos/**/*.int.spec.ts"],
        ["**/node_modules/**", "**/cierre-*.adv.int.spec.ts"],
        // 012b T24: la instrumentación v8 encarece generar 20.000 filas (6,4 s); la prueba de rendimiento de
        // generar-archivo.int.spec.ts multiplica su límite por 3 con esta marca. Bajo cobertura las pruebas de
        // tiempo corren sin comparar (ver test/tiempos.ts); la comparación estricta queda en `test:int`.
        { CONTAPP_COBERTURA: "1" },
      ),
      proyecto(
        "backend-unit",
        ["apps/backend/src/modules/trabajos/**/*.spec.ts"],
        sinInt,
      ),
      proyecto("backend-int", [
        "apps/backend/src/modules/trabajos/**/*.int.spec.ts",
      ]),
      proyecto("aislamiento-trabajos", ["tests/aislamiento/trabajos*.spec.ts"]),
    ],
    coverage: {
      provider: "v8",
      include: medidos,
      exclude: [
        "**/*.spec.ts",
        "**/*.adv.spec.ts",
        "**/*.int.spec.ts",
        "**/*.adv.int.spec.ts",
        // Dobles de prueba (no son producción ni pruebas): fuera de la medición (plan 008, Ratificaciones (6)).
        "packages/db/src/trabajos/soporte-prueba.ts",
        "packages/queue/src/soporte-pruebas/**",
      ],
      reporter: ["text", "json-summary"],
      // Un bloque por glob medido.
      thresholds: Object.fromEntries(medidos.map((g) => [g, porArchivo])),
    },
  },
});
