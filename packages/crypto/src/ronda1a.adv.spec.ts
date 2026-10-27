// Spec 003 · T14a · Ronda adversarial 1a (caja negra): lista mínima de ataques de la spec.
// Solo usa la interfaz pública (`./index`, `./descifrado`) y el fixture `mock` (llaves de prueba).
// Cada prueba afirma el comportamiento SEGURO esperado; si falla, es un hallazgo.
// Regla: nunca imprimir llaves, DEKs ni secretos en los mensajes de las aserciones.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspect, format } from "node:util";
import { serialize } from "node:v8";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfiguracionKeyProviderError,
  CryptoError,
  IntegridadError,
  KekDesconocidaError,
  SobreInvalidoError,
  cifrarCredencial,
  crearKeyWrapper,
  type Sobre,
} from "./index";
import {
  crearKeyUnwrapper,
  crearKeyUnwrapperAnterior,
  descifrarSobre,
  reenvolverDek,
  type KeyUnwrapper,
} from "./descifrado";
import {
  CANARIO_CLAVE,
  CANARIO_USUARIO,
  VALOR_SOL,
  borrarDir,
  capturarError,
  crearDirTemporal,
  ctxSol,
  generarParRsa,
  huellasDeFuga,
  type ParLocal,
} from "./soporte-pruebas";

const ENV_MOCK = { KEY_PROVIDER: "mock", NODE_ENV: "test" };
const FIXTURE = resolve(__dirname, "..", "fixtures", "mock-kek");
const FIXTURE_PUBLICA = join(FIXTURE, "SOLO-PRUEBAS-kek-mock-public.pem");
const FIXTURE_PRIVADA = join(FIXTURE, "SOLO-PRUEBAS-kek-mock-private.pem");

let sobre: Sobre;
let unwrapperMock: ReturnType<typeof crearKeyUnwrapper>;
let dir: string;
let k2: ParLocal;

/** Unwrapper que delega en el real y cuenta las llamadas a unwrap. */
function espia(real: KeyUnwrapper) {
  const estado = { llamadas: 0 };
  const u: KeyUnwrapper = {
    kekId: real.kekId,
    async unwrap(dek, kekId) {
      estado.llamadas++;
      return real.unwrap(dek, kekId);
    },
    verificar: () => real.verificar(),
  };
  return { u, estado };
}

/** Ningún texto derivado del error contiene el canario (sin imprimir el canario si aparece). */
function sinCanario(texto: string, donde: string) {
  for (const valor of [CANARIO_USUARIO, CANARIO_CLAVE]) {
    const fuga = huellasDeFuga(valor).some((h) => texto.includes(h));
    expect(fuga, `el canario aparece en ${donde}`).toBe(false);
  }
}

beforeAll(async () => {
  unwrapperMock = crearKeyUnwrapper(ENV_MOCK);
  sobre = await cifrarCredencial(crearKeyWrapper(ENV_MOCK), ctxSol(), VALOR_SOL);
  dir = await crearDirTemporal();
  k2 = await generarParRsa(dir, "k2");
}, 240_000);

afterAll(async () => {
  if (dir) await borrarDir(dir);
});

describe("R1a · tag truncado/vacío y nonce de otra longitud", () => {
  const casos: Array<[string, Partial<Sobre>]> = [
    ["tag vacío (0 B)", { tag: Buffer.alloc(0) }],
    ["tag de 1 B", { tag: Buffer.alloc(1) }],
    ["tag truncado a 4 B (mínimo que acepta GCM)", {}],
    ["tag truncado a 8 B", {}],
    ["tag truncado a 12 B", {}],
    ["tag truncado a 15 B", {}],
    ["tag de 17 B", {}],
    ["nonce vacío", { nonce: Buffer.alloc(0) }],
    ["nonce de 8 B", {}],
    ["nonce de 16 B", {}],
  ];
  // Los truncados se construyen a partir del tag/nonce reales (prefijo válido).
  const construir = (nombre: string, parcial: Partial<Sobre>): Sobre => {
    const m = /^(tag|nonce)[^0-9]*(\d+) B/.exec(nombre);
    if (m && Object.keys(parcial).length === 0) {
      const campo = m[1] as "tag" | "nonce";
      const n = Number(m[2]);
      const base = sobre[campo];
      const nuevo =
        n <= base.length
          ? Buffer.from(base.subarray(0, n))
          : Buffer.concat([base, Buffer.alloc(n - base.length)]);
      return { ...sobre, [campo]: nuevo };
    }
    return { ...sobre, ...parcial };
  };

  it.each(casos)(
    "%s -> se rechaza antes de desenvolver la DEK y sin texto",
    async (nombre, parcial) => {
      const { u, estado } = espia(unwrapperMock);
      let devuelto: unknown;
      const error = await capturarError(async () => {
        devuelto = await descifrarSobre(u, ctxSol(), construir(nombre, parcial));
      });
      expect(devuelto).toBeUndefined();
      expect(
        error instanceof SobreInvalidoError || error instanceof IntegridadError,
        `error tipado esperado, llegó ${error?.constructor?.name}`,
      ).toBe(true);
      expect(estado.llamadas, "unwrap no debe llamarse con un sobre mal formado").toBe(0);
    },
  );
});

describe("R1a · campos con tipos confusos o kek_id ajeno: error tipado, nunca TypeError", () => {
  const casos: Array<[string, Record<string, unknown>]> = [
    ["tag como texto hex", { tag: "00".repeat(16) }],
    ["tag como arreglo de números", { tag: Array.from({ length: 16 }, () => 0) }],
    ["ciphertext como texto", { ciphertext: "hola" }],
    ["nonce null", { nonce: null }],
    ["version 2 (sin downgrade/upgrade)", { version: 2 }],
    ["version 0", { version: 0 }],
    ["version '1' (texto)", { version: "1" }],
    ["kekId __proto__", { kekId: "__proto__" }],
    ["kekId constructor", { kekId: "constructor" }],
    ["kekId toString", { kekId: "toString" }],
    ["kekId hasOwnProperty", { kekId: "hasOwnProperty" }],
    ["kekId MOCK", { kekId: "MOCK" }],
    ["kekId 'mock ' (espacio)", { kekId: "mock " }],
    ["kekId mock\\0", { kekId: "mock\u0000" }],
    ["kekId k1 (ajeno a mock)", { kekId: "k1" }],
    ["kekId con |", { kekId: "mock|k1" }],
  ];

  it.each(casos)("%s -> CryptoError tipado", async (_n, parcial) => {
    let devuelto: unknown;
    const error = await capturarError(async () => {
      devuelto = await descifrarSobre(
        unwrapperMock,
        ctxSol(),
        { ...sobre, ...parcial } as unknown as Sobre,
      );
    });
    expect(devuelto).toBeUndefined();
    expect(
      error instanceof CryptoError,
      `se esperaba CryptoError y llegó ${error?.constructor?.name}`,
    ).toBe(true);
    sinCanario(`${error.message}\n${error.stack}\n${inspect(error)}`, "el error");
  });
});

describe("R1a · TOCTOU: el tag validado es el tag usado (sin aceptar tags cortos)", () => {
  it("un tag que mide 16 B al validarse y 4 B (prefijo real) al usarse no descifra", async () => {
    // Primera lectura: 16 B de ceros (pasa la validación de longitud, tag incorrecto).
    // Lecturas siguientes: los 4 primeros bytes del tag real. Si la implementación vuelve a leer
    // el campo y no fija authTagLength=16, GCM aceptaría un tag de 32 bits (forjable en ~2^32).
    const real = Buffer.from(sobre.tag);
    let lecturas = 0;
    const tramposo = { ...sobre } as Record<string, unknown>;
    Object.defineProperty(tramposo, "tag", {
      enumerable: true,
      get() {
        lecturas++;
        return lecturas === 1 ? Buffer.alloc(16) : Buffer.from(real.subarray(0, 4));
      },
    });
    let devuelto: unknown;
    const error = await capturarError(async () => {
      devuelto = await descifrarSobre(unwrapperMock, ctxSol(), tramposo as unknown as Sobre);
    });
    expect(devuelto, "no debe devolver el secreto con un tag de 4 B").toBeUndefined();
    expect(
      error instanceof IntegridadError || error instanceof SobreInvalidoError,
      `error tipado esperado, llegó ${error?.constructor?.name}`,
    ).toBe(true);
  });
});

describe("R1a · sobre/llave mock aceptados en local", () => {
  async function escribir(nombre: string, contenido: string | Buffer) {
    const ruta = join(dir, nombre);
    await writeFile(ruta, contenido, { mode: 0o600 });
    return ruta;
  }
  const pemPublica = () => readFileSync(FIXTURE_PUBLICA, "utf8");
  const pemPrivada = () => readFileSync(FIXTURE_PRIVADA, "utf8");

  const variantesPublica: Array<[string, () => string]> = [
    ["PKCS#1 (RSA PUBLIC KEY)", () =>
      createPublicKey(pemPublica()).export({ type: "pkcs1", format: "pem" }) as string],
    ["SPKI con CRLF", () => pemPublica().replace(/\r?\n/g, "\r\n")],
    // (con espacios antes de BEGIN OpenSSL ya no la parsea; solo líneas en blanco)
    ["SPKI con líneas en blanco alrededor", () => `\n\n${pemPublica().trim()}\n\n`],
  ];
  const variantesPrivada: Array<[string, () => string]> = [
    ["PKCS#1 (RSA PRIVATE KEY)", () =>
      createPrivateKey(pemPrivada()).export({ type: "pkcs1", format: "pem" }) as string],
    ["PKCS#8 con CRLF", () => pemPrivada().replace(/\r?\n/g, "\r\n")],
  ];

  it.each(variantesPublica)(
    "backend local con la pública mock re-codificada (%s) y nombre neutro no arranca",
    async (nombre, contenido) => {
      const ruta = await escribir(`pub-${nombre.replace(/\W+/g, "_")}.pem`, contenido());
      const error = await capturarError(async () => {
        const w = crearKeyWrapper({ KEY_PROVIDER: "local", KEK_ID: "k1", KEK_PUBLIC_KEY_PATH: ruta, NODE_ENV: "test" });
        await w.verificar();
        await w.wrap(Buffer.alloc(32, 7));
      });
      expect(
        error instanceof ConfiguracionKeyProviderError,
        `se esperaba ConfiguracionKeyProviderError y llegó ${error?.constructor?.name}`,
      ).toBe(true);
    },
  );

  it.each(variantesPrivada)(
    "worker local con la privada mock re-codificada (%s) y nombre neutro no arranca",
    async (nombre, contenido) => {
      const ruta = await escribir(`priv-${nombre.replace(/\W+/g, "_")}.pem`, contenido());
      const error = await capturarError(async () => {
        const u = crearKeyUnwrapper({ KEY_PROVIDER: "local", KEK_ID: "k1", KEK_PRIVATE_KEY_PATH: ruta, NODE_ENV: "test" });
        await u.verificar();
      });
      expect(
        error instanceof ConfiguracionKeyProviderError,
        `se esperaba ConfiguracionKeyProviderError y llegó ${error?.constructor?.name}`,
      ).toBe(true);
    },
  );

  it("la rotación no blanquea sobres mock hacia local (anterior = llave mock, con kek_id mock u otro)", async () => {
    const activa = crearKeyUnwrapper({
      KEY_PROVIDER: "local",
      KEK_ID: "k2",
      KEK_PRIVATE_KEY_PATH: k2.rutaPrivada,
      NODE_ENV: "test",
    });
    const copia = await escribir("k0-private.pem", readFileSync(FIXTURE_PRIVADA));
    const intentos: Array<[string, () => Promise<unknown>]> = [
      ["kek_id mock + fixture", async () => {
        const anterior = crearKeyUnwrapperAnterior({ kekId: "mock", rutaPrivada: FIXTURE_PRIVADA });
        return reenvolverDek(sobre, anterior, activa);
      }],
      ["kek_id k0 + copia del fixture, sobre mock re-etiquetado", async () => {
        const anterior = crearKeyUnwrapperAnterior({ kekId: "k0", rutaPrivada: copia });
        return reenvolverDek({ ...sobre, kekId: "k0" }, anterior, activa);
      }],
    ];
    for (const [nombre, fn] of intentos) {
      let devuelto: unknown;
      const error = await capturarError(async () => {
        devuelto = await fn();
      });
      expect(devuelto, `${nombre}: no debe devolver una DEK re-envuelta en k2`).toBeUndefined();
      expect(
        error instanceof ConfiguracionKeyProviderError || error instanceof KekDesconocidaError,
        `${nombre}: error tipado esperado, llegó ${error?.constructor?.name}`,
      ).toBe(true);
    }
  });
});

describe("R1a · canario: el Secreto no se filtra por introspección ni clonación", () => {
  it("inspect sin custom, showHidden, %o, structuredClone, v8.serialize, spread y propiedades propias", async () => {
    const secreto = await descifrarSobre(unwrapperMock, ctxSol(), sobre);
    // Control: el secreto sí es usable.
    expect(secreto.usar((v) => v.usuario === CANARIO_USUARIO)).toBe(true);

    const vistas: Array<[string, () => string]> = [
      ["String()", () => String(secreto)],
      ["plantilla", () => `${secreto as unknown as string}`],
      ["JSON anidado", () => JSON.stringify({ a: [secreto] })],
      ["inspect showHidden+getters", () => inspect(secreto, { showHidden: true, getters: true, depth: Infinity })],
      ["inspect customInspect:false", () => inspect(secreto, { customInspect: false, showHidden: true, depth: Infinity })],
      ["format %o", () => format("%o", secreto)],
      ["spread", () => inspect({ ...(secreto as object) }, { customInspect: false, showHidden: true, depth: Infinity })],
      ["structuredClone", () => {
        try {
          return inspect(structuredClone(secreto), { customInspect: false, showHidden: true, depth: Infinity });
        } catch {
          return "";
        }
      }],
      ["v8.serialize", () => {
        try {
          return serialize(secreto).toString("latin1");
        } catch {
          return "";
        }
      }],
      ["propiedades propias (nombres y símbolos)", () =>
        Reflect.ownKeys(secreto as object)
          .map((k) => {
            const d = Object.getOwnPropertyDescriptor(secreto, k);
            const v = d && "value" in d ? d.value : undefined;
            return inspect(v, { customInspect: false, showHidden: true, depth: Infinity });
          })
          .join("\n")],
    ];
    for (const [nombre, vista] of vistas) sinCanario(vista(), nombre);
  });
});
