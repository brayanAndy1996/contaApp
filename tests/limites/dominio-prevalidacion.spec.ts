import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// CA-11 (spec 012): lint de dinero (sin `number`) y de IO en packages/domain/src/prevalidacion/ y
// packages/domain/src/formatos/. El mismo código en un *.spec.ts pasa el lint de dinero.
// `@contapp/sunat` no se puede importar desde domain ni desde apps/backend; en
// packages/sunat/src/formatos/ sí se permite `node:crypto` (SHA-256 del empaquetado).
// Contrato (T7): cada violación usa uno de estos ruleId y un mensaje que menciona "packages/domain"
// (salvo la del backend, que menciona "apps/backend" o "@contapp/sunat").

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGLAS = new Set([
  "no-restricted-syntax",
  "no-restricted-imports",
  "no-restricted-properties",
  "no-restricted-globals",
]);

const CARPETAS = ["prevalidacion", "formatos"] as const;
const RUTA_TS = (c: string) => `packages/domain/src/${c}/__prueba__.ts`;
const RUTA_SPEC = (c: string) => `packages/domain/src/${c}/__prueba__.spec.ts`;

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

async function debeFallar(codigo: string, filePath: string, mencion = "packages/domain") {
  const v = await violaciones(codigo, filePath);
  expect(v.length).toBeGreaterThan(0);
  expect(v.every((m) => m.ruleId !== null && REGLAS.has(m.ruleId))).toBe(true);
  expect(v.some((m) => m.message.includes(mencion))).toBe(true);
}

// Dinero: `number`, conversiones numéricas y decimal.js (spec 010/011/012).
const CODIGO_CON_NUMBER: Array<[string, string]> = [
  ["variable anotada como number", `let x: number = 0; void x;`],
  ["parseFloat", `parseFloat("1");`],
  ["Number()", `Number("1");`],
  ["Math.round", `Math.round(1);`],
  ["+x unario", `declare const s: string; +s;`],
  ["toNumber()", `declare const d: { toNumber(): string }; d.toNumber();`],
  ["import de decimal.js", `import Decimal from "decimal.js"; void Decimal;`],
];

// IO: módulos de Node, el paquete de sunat y globales de codificación o red (D2 y CA-11).
// `TextEncoder` no está en `lib` ES2023 (plan, Archivos): la codificación va en texto/codificar.
const CODIGO_CON_IO: Array<[string, string]> = [
  ["import de node:crypto", `import "node:crypto";`],
  ["import de @contapp/sunat", `import "@contapp/sunat";`],
  ["TextEncoder", `new TextEncoder().encode("x");`],
  ["fetch", `fetch("x");`],
];

for (const carpeta of CARPETAS) {
  describe(`CA-11: lint de dinero e IO en packages/domain/src/${carpeta}`, () => {
    it.each(CODIGO_CON_NUMBER)("falla en dinero: %s", async (_n, codigo) => {
      await debeFallar(codigo, RUTA_TS(carpeta));
    });

    it.each(CODIGO_CON_IO)("falla en IO: %s", async (_n, codigo) => {
      await debeFallar(codigo, RUTA_TS(carpeta));
    });

    it.each(CODIGO_CON_NUMBER)("pasa en un *.spec.ts: %s", async (_n, codigo) => {
      expect(await violaciones(codigo, RUTA_SPEC(carpeta))).toEqual([]);
    });

    it("import type de Entero (texto/entero) pasa", async () => {
      const codigo = `import type { Entero } from "../texto"; export type Cuenta = Entero;`;
      expect(await violaciones(codigo, RUTA_TS(carpeta))).toEqual([]);
    });

    it("código sin number ni IO pasa", async () => {
      const codigo = `export const f = (m: string): string => m;`;
      expect(await violaciones(codigo, RUTA_TS(carpeta))).toEqual([]);
    });
  });
}

describe("CA-11: fronteras de paquetes", () => {
  it("apps/backend no puede importar @contapp/sunat", async () => {
    await debeFallar(`import "@contapp/sunat";`, "apps/backend/src/__prueba__.ts", "@contapp/sunat");
  });

  it("packages/sunat/src/formatos puede importar node:crypto (SHA-256 del empaquetado)", async () => {
    const codigo = `import { createHash } from "node:crypto"; export const h = createHash;`;
    expect(await violaciones(codigo, "packages/sunat/src/formatos/__prueba__.ts")).toEqual([]);
  });
});
