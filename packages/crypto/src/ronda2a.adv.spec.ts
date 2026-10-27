// Ronda adversarial 2a (spec 003, T16a), caja blanca sobre packages/crypto: reintenta por otra vía los
// hallazgos de la ronda 1 ya corregidos (F4 y F5). Cada prueba afirma el comportamiento SEGURO esperado:
// si falla, es un hallazgo (ver tasks.md, T16a). Sin llaves ni secretos reales.
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import {
  RngNoConfiableError,
  VENTANA_HUELLAS,
  crearGeneradorMaterial,
} from "./comun/aleatorio";

const RAIZ = resolve(__dirname, "..", "..", "..");

// Revisión T16a (opus): el período se fija en 10 000, el volumen de CA-2, y no en VENTANA_HUELLAS + 1.
// Atado a la ventana, la prueba fallaría con cualquier ventana acotada (no tendría arreglo posible); así
// exige que un ciclo dentro del volumen que garantiza CA-2 se detecte (hoy la ventana es de 4096).
const PERIODO_CA2 = 10_000;

describe("T16a · F5 por otra vía: RNG en ciclo más largo que la ventana de huellas", () => {
  it(`un RNG de período ${PERIODO_CA2} (CA-2; ventana actual ${VENTANA_HUELLAS}) no repite (DEK, nonce) sin detectarlo`, () => {
    // La ventana recuerda las últimas VENTANA_HUELLAS huellas. Un ciclo de una longitud mayor hace que
    // la primera DEK y el primer nonce ya no estén en la ventana cuando vuelven a salir.
    const periodo = PERIODO_CA2;
    const deks = Array.from({ length: periodo }, (_, i) => {
      const b = Buffer.alloc(32, 0x5a);
      b.writeUInt32BE(i + 1, 0);
      return b;
    });
    const nonces = Array.from({ length: periodo }, (_, i) => {
      const b = Buffer.alloc(12, 0xa5);
      b.writeUInt32BE(i + 1, 0);
      return b;
    });
    let cDek = 0;
    let cNonce = 0;
    const rng = (n: number): Buffer =>
      n === 32 ? Buffer.from(deks[cDek++ % periodo]!) : Buffer.from(nonces[cNonce++ % periodo]!);
    const generar = crearGeneradorMaterial(rng);
    const vistos = new Set<string>();
    let repetido: number | undefined;
    for (let k = 0; k <= periodo; k++) {
      let material: { dek: Buffer; nonce: Buffer };
      try {
        material = generar();
      } catch (e) {
        expect(e).toBeInstanceOf(RngNoConfiableError);
        break;
      }
      const clave = `${material.dek.toString("hex")}:${material.nonce.toString("hex")}`;
      if (vistos.has(clave)) {
        repetido = k;
        break;
      }
      vistos.add(clave);
    }
    // Seguro: el generador se niega antes de volver a emitir un par (DEK, nonce) del mismo proceso.
    expect(repetido, `el par (DEK, nonce) de la generación ${repetido} ya se había emitido`).toBeUndefined();
  });
});

describe("T16a · F4 por otra vía: cargas de @contapp/crypto/descifrado que el lint no reporta", () => {
  it("apps/backend no puede cargar el descifrado por una vía que la regla no cubre", async () => {
    const eslint = new ESLint({ cwd: RAIZ });
    const revisar = async (codigo: string) => {
      const [r] = await eslint.lintText(codigo, {
        filePath: join(RAIZ, "apps/backend/src/__r2a__.ts"),
      });
      const mensajes = r?.messages ?? [];
      return {
        noParsea: mensajes.some((m) => m.fatal),
        reportado: mensajes.some((m) => /descifrado/.test(m.message)),
      };
    };
    // Control: la vía literal sí se reporta (el arnés funciona).
    expect((await revisar('export const d = require("@contapp/crypto/descifrado");\n')).reportado).toBe(true);
    const casos: Array<[string, string]> = [
      ["alias de require", 'const r = require;\nexport const d = r("@contapp/crypto/descifrado");\n'],
      ["require.call", 'export const d = require.call(null, "@contapp/crypto/descifrado");\n'],
      ["eval", "export const d = eval('require(\"@contapp/crypto/descifrado\")');\n"],
      [
        "new Function",
        "export const d = new Function('r', 'return r(\"@contapp/crypto/descifrado\")')(require);\n",
      ],
      ["secuencia (0, require)", 'export const d = (0, require)("@contapp/crypto/descifrado");\n'],
      [
        "desestructurado de module",
        'const { require: r } = module;\nexport const d = r("@contapp/crypto/descifrado");\n',
      ],
      ["alias de module", 'const m = module;\nexport const d = m.require("@contapp/crypto/descifrado");\n'],
      [
        "module.constructor._load",
        'export const d = module.constructor._load("@contapp/crypto/descifrado", module);\n',
      ],
      [
        "require('module')._load",
        'export const d = require("module")._load("@contapp/crypto/descifrado", module);\n',
      ],
      [
        "globalThis.process.mainModule",
        'export const d = globalThis.process.mainModule?.require("@contapp/crypto/descifrado");\n',
      ],
      ["import d = require() (TypeScript)", 'import d = require("@contapp/crypto/descifrado");\nexport { d };\n'],
      // Revisión T16a (opus): apps/backend es ESM ("type": "module", nodenext); ahí `require` y `module`
      // no existen en ejecución, así que los casos de arriba solo son explotables desde un .cts/.cjs. Estas
      // dos vías sí funcionan en ESM (comprobado en Node 24 con un builtin) y la regla no las reporta.
      [
        "ESM: process.getBuiltinModule con clave calculada",
        'export const d = process.getBuiltinModule("node:module")["create" + "Require"](import.meta.url)("@contapp/crypto/descifrado");\n',
      ],
      [
        "ESM: new Module().require",
        'import Module from "node:module";\nconst m = new Module(import.meta.filename);\nexport const d = m.require("@contapp/crypto/descifrado");\n',
      ],
    ];
    const sinReportar: string[] = [];
    for (const [nombre, codigo] of casos) {
      const { noParsea, reportado } = await revisar(codigo);
      if (noParsea) sinReportar.push(`${nombre} [no parsea]`);
      else if (!reportado) sinReportar.push(nombre);
    }
    expect(sinReportar, "vías de carga del descifrado no reportadas en apps/backend").toEqual([]);
  }, 120_000); // La primera carga de la config de ESLint en frío tardó ~28 s: no basta el timeout de 30 s de la suite.
});
