import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// T11b · Ronda adversarial 1b, spec 010 (CA-1; plan: "Lint de dinero" y "decimal.js aislado").
// Evasiones del lint contra `number` y contra reconfigurar decimal.js que NO son "un valor
// numérico inferido sin anotación" (riesgo aceptado del plan): son las mismas funciones/tipos
// prohibidos con otro nombre. Ninguna la detecta tampoco el grep de CA-1 salvo globalThis.parseFloat.

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

describe("T11b · lint de dinero (ronda 1b)", () => {
  it.each<[string, string, string]>([
    ["globalThis.parseFloat", `export const f = (s: string) => globalThis.parseFloat(s);`, DINERO],
    ["Number aliasado", `const N = Number; export const f = (s: string) => N(s);`, DINERO],
    ["parseFloat aliasado", `const p = parseFloat; export const f = (s: string) => p(s);`, DINERO],
    ["globalThis.Number", `export const f = (s: string) => globalThis.Number(s);`, DINERO],
    ["tipo envoltorio Number", `export const f = (m: Number) => m;`, DINERO],
    ["Math aliasado", `const M = globalThis.Math; export const f = (s: string) => M.round(s.length);`, COMPROBANTE],
    [
      "D (clon de Decimal) reconfigurado desde comprobante/",
      `import { D } from "../dinero/decimal"; D.set({ rounding: 1 });`,
      COMPROBANTE,
    ],
  ])("R1b-7 · el lint de packages/domain detecta: %s", async (_nombre, codigo, ruta) => {
    expect((await violaciones(codigo, ruta)).length).toBeGreaterThan(0);
  });
});
