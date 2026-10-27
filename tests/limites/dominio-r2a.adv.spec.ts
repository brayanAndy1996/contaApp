import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// T13a · Ronda adversarial 2a (regresión de R1b-7), spec 010 (CA-1; plan: "Lint de dinero" y
// "decimal.js aislado"). Vías nuevas, distintas de las de T11b, hacia las mismas funciones y tipos
// prohibidos (Number, parseFloat, Math, el tipo number) o hacia reconfigurar decimal.js. No incluye
// "valores numéricos inferidos sin anotación" (riesgo aceptado del plan).

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGLAS = new Set([
  "no-restricted-syntax",
  "no-restricted-imports",
  "no-restricted-properties",
  "no-restricted-globals",
]);
const DINERO = "packages/domain/src/dinero/__prueba__.ts";
const COMPROBANTE = "packages/domain/src/comprobante/__prueba__.ts";

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: RAIZ });
});

async function violaciones(codigo: string, filePath: string) {
  const [resultado] = await eslint.lintText(codigo, { filePath: path.join(RAIZ, filePath) });
  return resultado.messages.filter(
    (m) => m.ruleId !== null && REGLAS.has(m.ruleId) && m.message.includes("packages/domain"),
  );
}

describe("T13a · lint de dinero (ronda 2a)", () => {
  it("R2a-6 · el lint de packages/domain detecta las vías nuevas hacia Number/parseFloat/Math, el tipo number y la reconfiguración de decimal.js (CA-1)", async () => {
    const casos: ReadonlyArray<readonly [string, string, string]> = [
      ["global.parseFloat (alias Node de globalThis)", `export const f = (s: string) => global.parseFloat(s);`, DINERO],
      ["self.Number (alias web de globalThis)", `export const f = (s: string) => self.Number(s);`, DINERO],
      ["window.Math", `export const f = (s: string) => window.Math.round(s.length);`, COMPROBANTE],
      ["Number vía (0).constructor", `export const f = (s: string) => (0).constructor(s);`, DINERO],
      ["parseFloat vía new Function", `export const f = new Function("s", "return parseFloat(s)");`, DINERO],
      ["globalThis vía Function('return this')()", `const g = Function("return this")(); export const f = (s: string) => g.parseFloat(s);`, DINERO],
      ["tipo number como string['length']", `export const f = (m: string["length"]) => m;`, DINERO],
      ["tipo number como ReturnType<String['indexOf']>", `export const f = (m: ReturnType<String["indexOf"]>) => m;`, COMPROBANTE],
      ["D[`set`] con template literal", `import { D } from "./decimal"; D[\`set\`]({ rounding: 1 });`, DINERO],
      ["instancia.constructor.set", `import { D } from "./decimal"; (new D(0).constructor as typeof D).set({ rounding: 1 });`, DINERO],
      ["Reflect.get(D, 'set')", `import { D } from "./decimal"; Reflect.get(D, "set").call(D, { rounding: 1 });`, DINERO],
      ["import() dinámico de decimal.js", `export const f = async () => (await import("decimal.js")).default.set({ rounding: 1 });`, COMPROBANTE],
    ];
    const abiertas: string[] = [];
    for (const [nombre, codigo, ruta] of casos) {
      if ((await violaciones(codigo, ruta)).length === 0) abiertas.push(`${nombre} (${ruta})`);
    }
    expect(abiertas).toEqual([]);
  });
});
