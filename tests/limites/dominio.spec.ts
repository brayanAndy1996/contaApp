import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// CA-1 y CA-12 (spec 010): lint de dinero (sin `number`) e IO (sin node:*, BD, HTTP) en
// packages/domain. Se prueba con ESLint#lintText sobre rutas ficticias, como en spec 003.
// Contrato para la regla (T7): cada violación se reporta con uno de estos ruleId
// (`no-restricted-syntax`, `no-restricted-imports`, `no-restricted-properties`,
// `no-restricted-globals`) y un mensaje que menciona "packages/domain".

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGLAS = new Set([
  "no-restricted-syntax",
  "no-restricted-imports",
  "no-restricted-properties",
  "no-restricted-globals",
]);

const DINERO = "packages/domain/src/dinero/__prueba__.ts";
const COMPROBANTE = "packages/domain/src/comprobante/__prueba__.ts";
const DINERO_SPEC = "packages/domain/src/dinero/__prueba__.spec.ts";
const COMPROBANTE_SPEC = "packages/domain/src/comprobante/__prueba__.spec.ts";
const DECIMAL_TS = "packages/domain/src/dinero/decimal.ts";
const COMPROBANTE_X = "packages/domain/src/comprobante/x.ts";
const CUALQUIERA = "packages/domain/src/cualquiera/__prueba__.ts";

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

// Código que no puede aparecer en dinero/ ni comprobante/ fuera de las pruebas.
const CODIGO_CON_NUMBER: Array<[string, string]> = [
  ["variable anotada como number", `let x: number = 0; void x;`],
  ["parámetro anotado como number", `export const f = (m: number) => m;`],
  ["parseFloat", `parseFloat("1");`],
  ["parseInt", `parseInt("1");`],
  ["Number()", `Number("1");`],
  ["new Number()", `new Number(1);`],
  ["toNumber()", `declare const d: { toNumber(): string }; d.toNumber();`],
  ["Math.round", `Math.round(1);`],
  ["+x unario", `declare const s: string; +s;`],
  ["import de decimal.js", `import Decimal from "decimal.js"; void Decimal;`],
  ["Decimal.set", `declare const Decimal: { set(o: object): void }; Decimal.set({});`],
];

const RUTAS_DE_DINERO: Array<[string, string]> = [
  ["dinero/", DINERO],
  ["comprobante/", COMPROBANTE],
];

describe("CA-1: lint de dinero en packages/domain/src/{dinero,comprobante}", () => {
  describe.each(RUTAS_DE_DINERO)("en %s", (_dir, ruta) => {
    it.each(CODIGO_CON_NUMBER)("falla: %s", async (_nombre, codigo) => {
      await debeFallar(codigo, ruta);
    });
  });

  describe.each([
    ["dinero/", DINERO_SPEC],
    ["comprobante/", COMPROBANTE_SPEC],
  ])("el mismo código en un *.spec.ts de %s pasa", (_dir, ruta) => {
    it.each(CODIGO_CON_NUMBER)("pasa: %s", async (_nombre, codigo) => {
      expect(await violaciones(codigo, ruta)).toEqual([]);
    });
  });

  it("decimal.js se puede importar en dinero/decimal.ts", async () => {
    expect(await violaciones(`import Decimal from "decimal.js"; void Decimal;`, DECIMAL_TS)).toEqual(
      [],
    );
  });

  it("Decimal.set se puede usar en dinero/decimal.ts", async () => {
    const codigo = `import Decimal from "decimal.js"; Decimal.set({ precision: 40 });`;
    expect(await violaciones(codigo, DECIMAL_TS)).toEqual([]);
  });

  it("decimal.js no se puede importar en comprobante/x.ts", async () => {
    await debeFallar(`import Decimal from "decimal.js"; void Decimal;`, COMPROBANTE_X);
  });

  it("decimal.js no se puede importar en otra carpeta de packages/domain/src", async () => {
    await debeFallar(`import Decimal from "decimal.js"; void Decimal;`, CUALQUIERA);
  });

  it("la regla de `number` no alcanza a otras carpetas de packages/domain/src", async () => {
    expect(await violaciones(`export const n: number = Math.round(1);`, CUALQUIERA)).toEqual([]);
  });

  it("código sin number ni decimal.js pasa en dinero/", async () => {
    const codigo = `export const f = (m: string): string => m;`;
    expect(await violaciones(codigo, DINERO)).toEqual([]);
  });
});

describe("CA-12: packages/domain no hace IO", () => {
  it.each<[string, string]>([
    ["import de node:fs", `import "node:fs";`],
    ["import de fs sin prefijo", `import fs from "fs"; void fs;`],
    ["import de pg", `import "pg";`],
    ["import de drizzle-orm", `import "drizzle-orm";`],
    ["import de @nestjs/common", `import "@nestjs/common";`],
    ["import de axios", `import "axios";`],
    ["import de @contapp/sunat", `import "@contapp/sunat";`],
    ["import de @contapp/db", `import "@contapp/db";`],
    ["fetch", `fetch("x");`],
    ["process.env", `process.env.X;`],
    ["Buffer.from", `Buffer.from("");`],
  ])("falla: %s", async (_nombre, codigo) => {
    await debeFallar(codigo, CUALQUIERA);
  });

  it("import de @contapp/shared pasa", async () => {
    expect(await violaciones(`import "@contapp/shared";`, CUALQUIERA)).toEqual([]);
  });
});
