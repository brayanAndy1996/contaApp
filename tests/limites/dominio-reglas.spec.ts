import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// CA-13 (spec 011): lint de dinero (sin `number`) en packages/domain/src/reglas/ y lint de IO
// (spec 010) en reglas/ y texto/. `texto/` queda fuera de la regla de `number` (usa índices).
// Contrato (T7): cada violación usa uno de estos ruleId y un mensaje que menciona "packages/domain".

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGLAS = new Set([
  "no-restricted-syntax",
  "no-restricted-imports",
  "no-restricted-properties",
  "no-restricted-globals",
]);

const REGLAS_TS = "packages/domain/src/reglas/__prueba__.ts";
const REGLAS_SPEC = "packages/domain/src/reglas/__prueba__.spec.ts";
const TEXTO_TS = "packages/domain/src/texto/__prueba__.ts";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: RAIZ });
});

async function violaciones(codigo: string, filePath: string) {
  const [resultado] = await eslint.lintText(codigo, {
    filePath: path.join(RAIZ, filePath),
  });
  return resultado.messages.filter((m) => m.ruleId !== null && REGLAS.has(m.ruleId));
}

async function debeFallar(codigo: string, filePath: string) {
  const v = await violaciones(codigo, filePath);
  expect(v.length).toBeGreaterThan(0);
  expect(v.every((m) => m.ruleId !== null && REGLAS.has(m.ruleId))).toBe(true);
  expect(v.some((m) => m.message.includes("packages/domain"))).toBe(true);
}

const CODIGO_CON_NUMBER: Array<[string, string]> = [
  ["variable anotada como number", `let x: number = 0; void x;`],
  ["parámetro anotado como number", `export const f = (m: number) => m;`],
  ["parseFloat", `parseFloat("1");`],
  ["Number()", `Number("1");`],
  ["Math.round", `Math.round(1);`],
  ["+x unario", `declare const s: string; +s;`],
  ["toNumber()", `declare const d: { toNumber(): string }; d.toNumber();`],
  ["import de decimal.js", `import Decimal from "decimal.js"; void Decimal;`],
];

describe("CA-13: lint de dinero en packages/domain/src/reglas", () => {
  it.each(CODIGO_CON_NUMBER)("falla en reglas/: %s", async (_nombre, codigo) => {
    await debeFallar(codigo, REGLAS_TS);
  });

  it.each(CODIGO_CON_NUMBER)("pasa en un *.spec.ts de reglas/: %s", async (_nombre, codigo) => {
    expect(await violaciones(codigo, REGLAS_SPEC)).toEqual([]);
  });

  it("código sin number ni decimal.js pasa en reglas/", async () => {
    const codigo = `export const f = (m: string): string => m;`;
    expect(await violaciones(codigo, REGLAS_TS)).toEqual([]);
  });

  it("reglas/ tampoco puede hacer IO (import de node:fs y fetch)", async () => {
    await debeFallar(`import "node:fs";`, REGLAS_TS);
    await debeFallar(`fetch("x");`, REGLAS_TS);
  });
});

describe("CA-13: texto/ queda fuera de la regla de number pero sin IO", () => {
  it("`let i: number = 0` pasa en texto/ (usa índices)", async () => {
    expect(await violaciones(`let i: number = 0; void i;`, TEXTO_TS)).toEqual([]);
  });

  it("import de node:fs falla en texto/", async () => {
    await debeFallar(`import "node:fs";`, TEXTO_TS);
  });

  it("fetch falla en texto/", async () => {
    await debeFallar(`fetch("x");`, TEXTO_TS);
  });
});
