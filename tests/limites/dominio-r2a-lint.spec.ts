import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// T13a · cobertura adicional del lint (R2a-6, spec 010, CA-1): más vías dinámicas hacia
// decimal.js/Number/Math, `import()` dinámico y alias de tipo, y que el código legítimo no se marque.

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DINERO = "packages/domain/src/dinero/__prueba__.ts";
const COMPROBANTE = "packages/domain/src/comprobante/__prueba__.ts";
const OTRO = "packages/domain/src/otro/__prueba__.ts";
const DECIMAL = "packages/domain/src/dinero/decimal.ts";
const PRUEBA = "packages/domain/src/dinero/__prueba__.spec.ts";

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: RAIZ });
});

async function violaciones(codigo: string, filePath: string) {
  const [r] = await eslint.lintText(codigo, { filePath: path.join(RAIZ, filePath) });
  return r.messages.filter((m) => m.message.includes("packages/domain"));
}

describe("T13a · lint (ronda 2a, cobertura extra)", () => {
  it.each<[string, string, string]>([
    ["new D(0).constructor", `import { D } from "./decimal"; export const f = new D(0).constructor;`, OTRO],
    ["constructor por índice", `export const f = (o: object) => o["constructor"];`, OTRO],
    ["__proto__", `export const f = (o: object) => (o as { __proto__: object }).__proto__;`, OTRO],
    ["Object.getPrototypeOf", `export const f = (o: object) => Object.getPrototypeOf(o);`, OTRO],
    ["Function sin new", `export const f = Function("return 1");`, OTRO],
    ["eval", `export const f = (s: string) => eval(s);`, OTRO],
    ["Reflect.apply", `export const f = () => Reflect.apply(String, undefined, []);`, OTRO],
    ["D como argumento", `import { D } from "./decimal"; export const f = () => Object.assign(D, { x: 1 });`, OTRO],
    ["D desestructurado", `import { D } from "./decimal"; const { set } = D; export const f = set;`, OTRO],
    ["D como valor de objeto", `import { D } from "./decimal"; export const f = { D };`, OTRO],
    ["D.precision = x", `import { D } from "./decimal"; D.precision = 3;`, OTRO],
    ["D.prototype", `import { D } from "./decimal"; export const f = D.prototype;`, OTRO],
    ["D[clave]", `import { D } from "./decimal"; export const f = (k: string) => D[k as "set"];`, OTRO],
    ["import() dinámico en otro/", `export const f = () => import("decimal.js");`, OTRO],
    ["import() dinámico en decimal.ts", `export const f = () => import("decimal.js");`, DECIMAL],
    ["globalThis.Number con window", `export const f = (s: string) => window.Number(s);`, OTRO],
    ["indexado de string", `export const f = (m: string["length"]) => m;`, DINERO],
    ["typeof en tipo", `const s = "a"; export const f = (m: ReturnType<typeof s.indexOf>) => m;`, COMPROBANTE],
    ["infer", `export type T<X> = X extends { length: infer N } ? N : never;`, DINERO],
  ])("detecta: %s", async (_n, codigo, ruta) => {
    expect((await violaciones(codigo, ruta)).length).toBeGreaterThan(0);
  });

  it.each<[string, string, string]>([
    ["new D legítimo", `import { D } from "./decimal"; export const f = (s: string) => new D(s).plus(1).isZero();`, DINERO],
    ["D.ROUND_HALF_UP", `import { D } from "./decimal"; export const f = D.ROUND_HALF_UP;`, OTRO],
    ["instanceof D", `import { D } from "./decimal"; export const f = (x: unknown) => x instanceof D;`, OTRO],
    ["constructor privado de clase", `export class A { private constructor(readonly v: string) {} static de(v: string) { return new A(v); } }`, DINERO],
    ["propiedad de objeto llamada Reflect", `export const f = (o: Record<string, string>) => o.Reflect;`, OTRO],
    ["decimal.ts declara D", `import { Decimal } from "decimal.js"; export const D = Decimal.clone({ rounding: 4 });`, DECIMAL],
    ["tipo indexado fuera de dinero/comprobante", `export const f = (m: string["length"]) => m;`, OTRO],
    ["import() en pruebas", `export const f = () => import("decimal.js");`, PRUEBA],
  ])("no marca: %s", async (_n, codigo, ruta) => {
    expect(await violaciones(codigo, ruta)).toEqual([]);
  });
});
