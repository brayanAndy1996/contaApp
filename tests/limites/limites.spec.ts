import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// CA-4b (spec 003): una regla de lint impide que apps/backend importe el punto de entrada
// de descifrado de @contapp/crypto. Se prueba con ESLint#lintText sobre rutas ficticias.
// Contrato para la regla (T11): cada violación se reporta con ruleId
// `no-restricted-imports` o `limites/imports-relativos` y un mensaje que menciona
// "descifrado" (y `apps/backend` cuando el origen es el backend).

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGLAS_DE_LIMITE = new Set(["no-restricted-imports", "limites/imports-relativos"]);

const BACKEND = "apps/backend/src/__prueba__.ts";
const WORKER = "apps/worker/src/__prueba__.ts";
const CIFRADO = "packages/crypto/src/cifrado/__prueba__.ts";
const DESCIFRADO = "packages/crypto/src/descifrado/__prueba__.ts";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: RAIZ });
});

async function violacionesDeLimite(codigo: string, filePath: string) {
  const [resultado] = await eslint.lintText(codigo, {
    filePath: path.join(RAIZ, filePath),
  });
  return resultado.messages.filter(
    (m) => m.ruleId !== null && REGLAS_DE_LIMITE.has(m.ruleId),
  );
}

// Los 7 casos del plan (Decisiones: Lint): import estático, dinámico, export … from,
// require, ruta relativa a src, ruta relativa a dist, y subrutas del paquete (dist/src).
const CASOS_BACKEND: Array<[string, string]> = [
  ["import estático del subpath descifrado", `import "@contapp/crypto/descifrado";`],
  ["import dinámico del subpath descifrado", `void import("@contapp/crypto/descifrado");`],
  ["export … from del subpath descifrado", `export * from "@contapp/crypto/descifrado";`],
  ["require literal del subpath descifrado", `require("@contapp/crypto/descifrado");`],
  [
    "ruta relativa a packages/crypto/src/descifrado",
    `import "../../../packages/crypto/src/descifrado/descifrar";`,
  ],
  [
    "ruta relativa a packages/crypto/dist/descifrado",
    `import "../../../packages/crypto/dist/descifrado.js";`,
  ],
  [
    "subruta @contapp/crypto/dist/**",
    `import "@contapp/crypto/dist/descifrado.js";`,
  ],
  [
    "subruta @contapp/crypto/src/**",
    `import "@contapp/crypto/src/descifrado/descifrar";`,
  ],
  [
    "ruta relativa al punto de entrada src/descifrado.ts",
    `import "../../../packages/crypto/src/descifrado";`,
  ],
  [
    "export nombrado … from una ruta relativa de descifrado",
    `export { descifrarSobre } from "../../../packages/crypto/src/descifrado/descifrar";`,
  ],
  [
    "require de una ruta relativa a dist/descifrado",
    `require("../../../packages/crypto/dist/descifrado.js");`,
  ],
  [
    "import dinámico de una ruta relativa a src/descifrado",
    `void import("../../../packages/crypto/src/descifrado/secreto");`,
  ],
];

describe("CA-4b: apps/backend no importa el descifrado", () => {
  it.each(CASOS_BACKEND)("falla con el mensaje de la regla: %s", async (_nombre, codigo) => {
    const violaciones = await violacionesDeLimite(codigo, BACKEND);
    expect(violaciones.length).toBeGreaterThan(0);
    expect(violaciones.some((m) => /descifrad/i.test(m.message))).toBe(true);
  });

  it("el lado de cifrado `@contapp/crypto` sigue permitido", async () => {
    expect(await violacionesDeLimite(`import "@contapp/crypto";`, BACKEND)).toEqual([]);
  });

  it("require de `@contapp/crypto` (cifrado) sigue permitido", async () => {
    expect(await violacionesDeLimite(`require("@contapp/crypto");`, BACKEND)).toEqual([]);
  });

  it("las reglas previas siguen vigentes (no se importa packages/sunat)", async () => {
    const violaciones = await violacionesDeLimite(`import "@contapp/sunat";`, BACKEND);
    expect(violaciones.length).toBeGreaterThan(0);
  });

  it.each(CASOS_BACKEND)("el mismo código en apps/worker pasa: %s", async (_nombre, codigo) => {
    expect(await violacionesDeLimite(codigo, WORKER)).toEqual([]);
  });
});

describe("estructura de packages/crypto: cifrado/ nunca importa descifrado/", () => {
  it.each([
    ["import de ../descifrado/descifrar", `import "../descifrado/descifrar";`],
    ["import del índice ../descifrado", `import "../descifrado";`],
    ["export … from ../descifrado/secreto", `export * from "../descifrado/secreto";`],
    ["import dinámico de ../descifrado/fabrica", `void import("../descifrado/fabrica");`],
    ["require de ../descifrado/descifrar", `require("../descifrado/descifrar");`],
  ])("un archivo de cifrado/ falla: %s", async (_nombre, codigo) => {
    const violaciones = await violacionesDeLimite(codigo, CIFRADO);
    expect(violaciones.length).toBeGreaterThan(0);
    expect(violaciones.some((m) => /descifrad/i.test(m.message))).toBe(true);
  });

  it("cifrado/ puede importar comun/", async () => {
    expect(await violacionesDeLimite(`import "../comun/aad";`, CIFRADO)).toEqual([]);
  });

  it("descifrado/ puede importar comun/", async () => {
    expect(await violacionesDeLimite(`import "../comun/aad";`, DESCIFRADO)).toEqual([]);
  });
});
