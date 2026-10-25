// Ronda adversarial 1b (spec 003, T14b), caja blanca sobre packages/crypto. Cada prueba afirma el
// comportamiento SEGURO esperado: si falla, es un hallazgo (ver tasks.md, T14b). Solo llaves de prueba
// generadas al vuelo en un directorio temporal o el fixture `mock`; nunca se imprimen.
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CryptoError,
  cifrarCredencial,
  crearKeyWrapper,
  type Sobre,
} from "./index";
import {
  crearKeyUnwrapper,
  crearKeyUnwrapperAnterior,
  reenvolverDek,
} from "./descifrado";
import {
  VALOR_SOL,
  borrarDir,
  crearDirTemporal,
  ctxSol,
  generarParRsa,
  wrapperEspia,
  type ParLocal,
} from "./soporte-pruebas";

// RNG controlable: por defecto delega en el CSPRNG real; una prueba encola salidas fijas.
const rng = vi.hoisted(() => ({ cola: [] as Buffer[] }));
vi.mock("node:crypto", async (original) => {
  const real = await original<typeof import("node:crypto")>();
  const randomBytes = ((n: number, ...resto: unknown[]) => {
    if (resto.length === 0 && rng.cola.length > 0) {
      return Buffer.from(rng.cola.shift() as Buffer);
    }
    return (real.randomBytes as (...a: unknown[]) => Buffer)(n, ...resto);
  }) as typeof real.randomBytes;
  return { ...real, randomBytes, default: { ...real, randomBytes } };
});

const RAIZ = resolve(__dirname, "..", "..", "..");

let dir: string;
let k1: ParLocal;

beforeAll(async () => {
  dir = await crearDirTemporal();
  k1 = await generarParRsa(dir, "r1b-k1");
}, 120_000);

afterAll(async () => {
  if (dir) await borrarDir(dir);
});

describe("T14b · RNG atascado en ciclo", () => {
  it("un RNG que alterna dos salidas (A, B, A) no produce dos sobres con la misma (DEK, nonce)", async () => {
    const dekA = Buffer.alloc(32, 0x11);
    const nonceA = Buffer.alloc(12, 0x21);
    const dekB = Buffer.alloc(32, 0x12);
    const nonceB = Buffer.alloc(12, 0x22);
    rng.cola.push(dekA, nonceA, dekB, nonceB, dekA, nonceA);
    const { wrapper } = wrapperEspia();
    const sobres: Sobre[] = [];
    let rechazado = false;
    try {
      for (let i = 0; i < 3; i++) {
        sobres.push(await cifrarCredencial(wrapper, ctxSol(), { usuario: `u${i}`, clave: `c${i}` }));
      }
    } catch (e) {
      rechazado = e instanceof CryptoError;
    } finally {
      rng.cola.length = 0;
    }
    // Seguro: el tercer cifrado se rechaza (RNG no confiable) o al menos no reutiliza el nonce de la
    // misma DEK. Reutilizar (DEK, nonce) en GCM expone el XOR de los planos y la llave de autenticación.
    const nonces = sobres.map((s) => s.nonce.toString("hex"));
    expect(new Set(nonces).size, "nonce reutilizado con la misma DEK").toBe(nonces.length);
    expect(rechazado).toBe(true);
  });
});

describe("T14b · rotación hacia el proveedor mock (downgrade)", () => {
  it("reenvolverDek no re-envuelve un sobre `local` con la KEK `mock` (privada pública en el repo)", async () => {
    const w = crearKeyWrapper({
      KEY_PROVIDER: "local",
      KEK_ID: "r1b-k1",
      KEK_PUBLIC_KEY_PATH: k1.rutaPublica,
      NODE_ENV: "test",
    });
    const sobre = await cifrarCredencial(w, ctxSol(), VALOR_SOL);
    const anterior = crearKeyUnwrapperAnterior({ kekId: "r1b-k1", rutaPrivada: k1.rutaPrivada });
    // Es lo que hace `kek:rotar` si el entorno del worker conserva KEY_PROVIDER=mock (valor por defecto).
    const activaMock = crearKeyUnwrapper({ KEY_PROVIDER: "mock", NODE_ENV: "test" });
    let resultado: unknown;
    let error: unknown;
    try {
      resultado = await reenvolverDek(sobre, anterior, activaMock);
    } catch (e) {
      error = e;
    }
    expect(
      (resultado as { kekId?: string } | undefined)?.kekId,
      "una DEK real quedó envuelta con la llave del fixture mock",
    ).toBeUndefined();
    expect(error).toBeInstanceOf(CryptoError);
  });
});

describe("T14b · importación del descifrado desde apps/backend por vías no literales", () => {
  it("la regla de lint reporta require/import() con plantilla, createRequire y module.require", async () => {
    const eslint = new ESLint({ cwd: RAIZ });
    const casos: Array<[string, string]> = [
      ["require con plantilla", "const d = require(`@contapp/crypto/descifrado`);\nexport default d;\n"],
      ["import() con plantilla", "export const d = import(`@contapp/crypto/descifrado`);\n"],
      [
        "createRequire",
        'import { createRequire } from "node:module";\nexport const d = createRequire(__filename)("@contapp/crypto/descifrado");\n',
      ],
      ["module.require", 'export const d = module.require("@contapp/crypto/descifrado");\n'],
    ];
    const reporta = async (codigo: string) => {
      const [r] = await eslint.lintText(codigo, {
        filePath: join(RAIZ, "apps/backend/src/__r1b__.ts"),
      });
      const mensajes = r?.messages ?? [];
      expect(mensajes.filter((m) => m.fatal), "el código de prueba no parsea").toEqual([]);
      return mensajes.some((m) => /descifrado/.test(m.message));
    };
    // Control: la vía literal sí se reporta (el arnés funciona).
    expect(await reporta('export const d = require("@contapp/crypto/descifrado");\n')).toBe(true);
    const sinReportar: string[] = [];
    for (const [nombre, codigo] of casos) {
      if (!(await reporta(codigo))) sinReportar.push(nombre);
    }
    expect(sinReportar).toEqual([]);
  });
});
