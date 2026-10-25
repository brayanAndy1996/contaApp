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
];

const PERMITIDOS: Array<[string, string]> = [
  ["import del paquete principal", 'import { cifrarCredencial } from "@contapp/crypto";\nexport { cifrarCredencial };'],
  ["import() literal del paquete principal", 'export const d = import("@contapp/crypto");'],
  ["import() con plantilla estática del principal", "export const d = import(`@contapp/crypto`);"],
  ["require literal del paquete principal", 'export const d = require("@contapp/crypto");'],
  ["import estático de un paquete cualquiera", 'import { Injectable } from "@nestjs/common";\nexport { Injectable };'],
  ["require.resolve no es require()", 'export const d = require.resolve("@contapp/crypto");'],
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
