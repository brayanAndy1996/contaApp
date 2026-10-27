import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Spec 003, F4 (ronda adversarial 1): apps/backend no puede evadir la prohibición del descifrado con
// import()/require() de especificador no estático, createRequire o module.require.

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKEND = "apps/backend/src/__evasion__.ts";
const WORKER = "apps/worker/src/__evasion__.ts";

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: RAIZ });
});

async function mensajes(codigo: string, filePath: string) {
  const [r] = await eslint.lintText(codigo, { filePath: path.join(RAIZ, filePath) });
  expect(r.messages.filter((m) => m.fatal), "el código de prueba no parsea").toEqual([]);
  return r.messages.filter(
    (m) => m.ruleId === "limites/imports-relativos" || m.ruleId === "no-restricted-imports",
  );
}

const PROHIBIDOS: Array<[string, string]> = [
  ["require con plantilla sin expresiones", "export const d = require(`@contapp/crypto/descifrado`);"],
  ["import() con plantilla sin expresiones", "export const d = import(`@contapp/crypto/descifrado`);"],
  ["require con plantilla interpolada", "const n = 'descifrado';\nexport const d = require(`@contapp/crypto/${n}`);"],
  ["import() con plantilla interpolada", "const n = 'descifrado';\nexport const d = import(`@contapp/crypto/${n}`);"],
  ["require con concatenación", "export const d = require('@contapp/crypto/' + 'descifrado');"],
  ["import() con concatenación", "export const d = import('@contapp/crypto/' + 'descifrado');"],
  ["require con identificador", "const m = '@contapp/crypto/descifrado';\nexport const d = require(m);"],
  ["import() con identificador", "const m = '@contapp/crypto/descifrado';\nexport const d = import(m);"],
  ["require sin argumento", "export const d = require();"],
  [
    "createRequire importado",
    'import { createRequire } from "node:module";\nexport const d = createRequire(__filename)("./x");',
  ],
  ["createRequire vía módulo", 'import * as m from "node:module";\nexport const d = m.createRequire(__filename);'],
  ["module.require", 'export const d = module.require("@contapp/crypto/descifrado");'],
  ['module["require"]', 'export const d = module["require"]("@contapp/crypto/descifrado");'],
  ["require.main.require", 'export const d = require.main?.require("@contapp/crypto/descifrado");'],
  ["process.mainModule.require", 'export const d = process.mainModule?.require("x");'],
  // Spec 003, R2a-2 (ronda adversarial 2).
  ["alias de require", 'const r = require;\nexport const d = r("@contapp/crypto/descifrado");'],
  ["require.call", 'export const d = require.call(null, "@contapp/crypto/descifrado");'],
  ["eval", "export const d = eval('require(\"@contapp/crypto/descifrado\")');"],
  ["new Function", "export const d = new Function('r', 'return r(1)')(require);"],
  ["secuencia (0, require)", 'export const d = (0, require)("@contapp/crypto/descifrado");'],
  ["desestructurado de module", 'const { require: r } = module;\nexport const d = r("x");'],
  ["alias de module", 'const m = module;\nexport const d = m.require("x");'],
  ["module.constructor._load", 'export const d = module.constructor._load("x", module);'],
  ["require('module')", 'export const d = require("module")._load("x", module);'],
  ["globalThis.process.mainModule", 'export const d = globalThis.process.mainModule?.require("x");'],
  ["import = require (TypeScript)", 'import d = require("@contapp/crypto/descifrado");\nexport { d };'],
  // Spec 003, R2a-2 (revisión T16a): vías ESM.
  ["process.getBuiltinModule literal", 'export const m = process.getBuiltinModule("node:module");'],
  [
    "process.getBuiltinModule con clave calculada",
    'export const m = process.getBuiltinModule(["mo", "dule"].join(""));',
  ],
  ["process.getBuiltinModule sin llamar", "export const f = process.getBuiltinModule;"],
  ["process con alias", 'const p = process;\nexport const m = p.getBuiltinModule("node:module");'],
  ["globalThis.process.getBuiltinModule", 'export const m = globalThis.process.getBuiltinModule("node:fs");'],
  ["process['getBuiltinModule']", 'export const m = process["getBuiltinModule"]("node:module");'],
  ["process[clave calculada]", 'export const m = process["getBuiltin" + "Module"]("node:module");'],
  ["process[identificador]", 'const k = "getBuiltinModule";\nexport const m = process[k]("node:module");'],
  ["process con plantilla estática", "export const m = process[`getBuiltinModule`]('node:module');"],
  [
    "desestructurado de process",
    'const { getBuiltinModule } = process;\nexport const m = getBuiltinModule("node:module");',
  ],
  [
    "desestructurado de process con alias",
    'const { getBuiltinModule: g } = process;\nexport const m = g("node:module");',
  ],
  [
    "desestructurado de process con clave calculada",
    'const k = "getBuiltinModule";\nconst { [k]: g } = process;\nexport const m = g("node:module");',
  ],
  [
    "asignación desestructurada de process con clave calculada",
    'let g: unknown;\nconst k = "getBuiltinModule";\n({ [k]: g } = process);\nexport { g };',
  ],
  [
    "new Module().require",
    'import Module from "node:module";\nconst m = new Module("x");\nexport const d = m.require("@contapp/crypto/descifrado");',
  ],
  ["import Module de 'module'", 'import Module from "module";\nexport const m = new Module("x");'],
  ["import() de node:module", 'export const m = import("node:module");'],
  ["require de node:module", 'export const m = require("node:module");'],
  ["instancia con .require()", "export const f = (m: { require(s: string): unknown }) => m.require('x');"],
  ["Module._load", "export const f = (M: { _load(s: string): unknown }) => M._load('x');"],
];

const PERMITIDOS: Array<[string, string]> = [
  ["import del paquete principal", 'import { cifrarCredencial } from "@contapp/crypto";\nexport { cifrarCredencial };'],
  ["import() literal del paquete principal", 'export const d = import("@contapp/crypto");'],
  ["import() con plantilla estática del principal", "export const d = import(`@contapp/crypto`);"],
  ["require literal del paquete principal", 'export const d = require("@contapp/crypto");'],
  ["import estático de un paquete cualquiera", 'import { Injectable } from "@nestjs/common";\nexport { Injectable };'],
  ["require.resolve no es require()", 'export const d = require.resolve("@contapp/crypto");'],
  ["module.exports / module.hot", "if (module.hot) module.hot.accept();\nmodule.exports = {};"],
  ["typeof require / module", 'export const d = typeof require !== "undefined" && typeof module !== "undefined";'],
  ["module local (Nest Test)", "export async function f(t: { compile(): Promise<unknown> }) {\n  const module = await t.compile();\n  return module;\n}"],
  ["Function como tipo", "export type Cb = Function;\nexport const g = (cb: Function) => cb;"],
  ["import = require del principal", 'import c = require("@contapp/crypto");\nexport { c };'],
  ["process.env con clave calculada", "export const v = (k: string) => process.env[k];"],
  ["process.env / process.cwd", "export const v = [process.env.NODE_ENV, process.cwd(), process.exit];"],
  ["globalThis estático", "export const t = globalThis.setTimeout;"],
  ["desestructurado de process.env", "const { NODE_ENV, PORT } = process.env;\nexport { NODE_ENV, PORT };"],
  ["propiedad require sin llamar", "export const s = { require: true };\nexport const r = s.require;"],
];

describe("F4: apps/backend no evade la prohibición del descifrado", () => {
  it.each(PROHIBIDOS)("reporta: %s", async (_n, codigo) => {
    const v = await mensajes(codigo, BACKEND);
    expect(v.length, "debería reportarse").toBeGreaterThan(0);
    expect(v.some((m) => /descifrado/.test(m.message))).toBe(true);
  });

  it.each(PERMITIDOS)("no reporta: %s", async (_n, codigo) => {
    expect(await mensajes(codigo, BACKEND)).toEqual([]);
  });

  it("las restricciones de evasión solo aplican a apps/backend (el worker usa import() dinámico)", async () => {
    const codigo =
      "const m = '@contapp/crypto/descifrado';\nexport const d = import(m);\nexport const r = require(m);";
    expect(await mensajes(codigo, WORKER)).toEqual([]);
  });
});
