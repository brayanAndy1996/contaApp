import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// T11b · cobertura adicional del lint de dinero y decimal.js (ronda 1b, spec 010, CA-1):
// más vías de `number`/Math/globalThis y de D/Decimal.set, y que el código legítimo no se marque.

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DINERO = "packages/domain/src/dinero/__prueba__.ts";
const COMPROBANTE = "packages/domain/src/comprobante/__prueba__.ts";
const OTRO = "packages/domain/src/otro/__prueba__.ts";
const DECIMAL = "packages/domain/src/dinero/decimal.ts";

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: RAIZ });
});

async function violaciones(codigo: string, filePath: string) {
  const [r] = await eslint.lintText(codigo, { filePath: path.join(RAIZ, filePath) });
  return r.messages.filter((m) => m.message.includes("packages/domain"));
}

describe("T11b · lint de dinero (cobertura extra)", () => {
  it.each<[string, string, string]>([
    ["desestructurado", `const { parseFloat: p } = globalThis; export const f = p;`, DINERO],
    ["desestructurado de Number", `const { parseInt } = Number; export const f = parseInt;`, COMPROBANTE],
    ["globalThis aliasado", `const g = globalThis; export const f = g.parseFloat;`, DINERO],
    ["acceso por índice", `export const f = globalThis["parseFloat"];`, DINERO],
    ["Math por índice", `const g = {}; export const f = (g as any)["Math"];`, COMPROBANTE],
    ["Number.parseFloat", `export const f = (s: string) => Number.parseFloat(s);`, DINERO],
    ["new Number", `export const f = (s: string) => new Number(s);`, COMPROBANTE],
    ["Math.round", `export const f = (x: string) => Math.round(x.length);`, DINERO],
    ["tipo Number en genérico", `export const f: Array<Number> = [];`, COMPROBANTE],
    ["D.set desde otro módulo", `import { D } from "../dinero/decimal"; D.set({ precision: 3 });`, OTRO],
    ["D.config", `import { D } from "../dinero/decimal"; D.config({ precision: 3 });`, COMPROBANTE],
    ["D.set por índice", `import { D } from "../dinero/decimal"; D["set"]({ precision: 3 });`, OTRO],
    ["D con alias", `import { D as X } from "../dinero/decimal"; X.set({ precision: 3 });`, COMPROBANTE],
    ["import * de decimal", `import * as dec from "../dinero/decimal"; dec.D.set({});`, OTRO],
    ["Decimal.set", `import { Decimal } from "decimal.js"; Decimal.set({});`, OTRO],
  ])("detecta: %s", async (_n, codigo, ruta) => {
    expect((await violaciones(codigo, ruta)).length).toBeGreaterThan(0);
  });

  it.each<[string, string, string]>([
    ["código legítimo con D", `import { D } from "./decimal"; export const f = (s: string) => new D(s).plus(1);`, DINERO],
    ["propiedad llamada parseFloat de un objeto", `export const f = (o: Record<string, string>) => o.parseFloat;`, DINERO],
    ["Map.set no se marca", `export const f = (m: Map<string, string>) => m.set("a", "b");`, COMPROBANTE],
    ["decimal.ts puede usar Decimal", `import { Decimal } from "decimal.js"; export const D = Decimal.clone({ rounding: 4 });`, DECIMAL],
  ])("no marca: %s", async (_n, codigo, ruta) => {
    expect(await violaciones(codigo, ruta)).toEqual([]);
  });

  it("el lint de number no aplica fuera de dinero/ y comprobante/", async () => {
    expect(await violaciones(`export const f = (s: string) => Math.round(Number(s));`, OTRO)).toEqual([]);
  });

  it("el lint de number no aplica en *.spec.ts", async () => {
    expect(
      await violaciones(`export const f = (s: string) => Math.round(Number(s));`, "packages/domain/src/dinero/x.spec.ts"),
    ).toEqual([]);
  });
});
