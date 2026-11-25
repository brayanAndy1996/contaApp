import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Cobertura única del backend (spec 042, A1): una sola corrida, con todas las suites, mide lo que antes medían
// las 12 configuraciones por spec (004 auth, 005 acceso, 012b archivos, 016 XML, 017 auditoría, 021 reglas,
// 023 buzones, 024 bandeja, 025 aprendizaje, 026 prorrata, 027 gastos y 028 correo).
// Umbral de 90 % por archivo en cada glob de `medidos` (D1: no se baja). Una spec nueva agrega sus globs a
// `medidos` y, si sus suites no entran en un proyecto, el proyecto; no agrega una config ni un paso de CI (A6).
const raiz = fileURLToPath(new URL("../..", import.meta.url));
const ruta = (relativa: string) =>
  fileURLToPath(new URL(relativa, import.meta.url));

// Carga el .env del repo y el del backend si existen.
for (const archivo of [ruta("../../.env"), ruta("./.env")]) {
  if (existsSync(archivo)) {
    process.loadEnvFile(archivo);
  }
}
// 029 (D1): `TOTP_CLAVE` es obligatoria para arrancar; sin una en el entorno, las pruebas usan una efímera.
process.env.TOTP_CLAVE ??= `1:${randomBytes(32).toString("base64")}`;

// Los paquetes se importan desde la fuente para que cuenten en cobertura.
const alias = [
  { find: "@contapp/db", replacement: ruta("../../packages/db/src/index.ts") },
  {
    find: "@contapp/shared",
    replacement: ruta("../../packages/shared/src/index.ts"),
  },
];

const proyecto = (
  name: string,
  include: string[],
  exclude: string[] = ["**/node_modules/**"],
) => ({
  resolve: { alias },
  test: {
    name,
    root: raiz,
    // Spec 020 (P-4): bajo cobertura las pruebas de tiempo corren pero no comparan (lectura CA-15, auth CA-8).
    env: { CONTAPP_COBERTURA: "1" },
    include,
    exclude,
    // Las suites con BD comparten la misma base: nada en paralelo.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

// Lo que se mide: unión de los `coverage.include` de las 12 configuraciones. Los de 012b a 028 (módulos del
// backend) ya caen dentro de `modules/**`, `infra/**` y `comun/**`.
const medidos = [
  "apps/backend/src/app.ts",
  "apps/backend/src/config/**/*.ts",
  "apps/backend/src/infra/**/*.ts",
  "apps/backend/src/comun/**/*.ts",
  "apps/backend/src/modules/**/*.ts",
  "packages/db/src/auth/**/*.ts",
  "packages/db/src/acceso/**/*.ts",
  "packages/shared/src/auth/**/*.ts",
  "packages/shared/src/acceso/**/*.ts",
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
      proyecto(
        "backend-unit",
        ["apps/backend/src/**/*.spec.ts"],
        ["**/node_modules/**", "**/*.int.spec.ts"],
      ),
      proyecto("backend-int", ["apps/backend/src/**/*.int.spec.ts"]),
      proyecto("aislamiento", [
        "tests/aislamiento/auth*.spec.ts",
        "tests/aislamiento/acceso*.spec.ts",
      ]),
      proyecto("shared", ["packages/shared/src/**/*.spec.ts"]),
      proyecto("db", [
        "packages/db/src/auth/**/*.spec.ts",
        "packages/db/src/acceso/**/*.spec.ts",
      ]),
    ],
    coverage: {
      provider: "v8",
      include: medidos,
      exclude: ["**/*.spec.ts", "**/*.adv.spec.ts", "**/*.int.spec.ts"],
      reporter: ["text", "json-summary"],
      // Un bloque por glob medido.
      thresholds: Object.fromEntries(medidos.map((g) => [g, porArchivo])),
    },
  },
});
