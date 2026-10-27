// Ronda adversarial 2b (spec 003, T16b), caja blanca sobre packages/crypto: plazo del proveedor, modo
// `mock` y NODE_ENV, carga de llaves no RSA o por rutas con `..`, y `kek:generar` dentro del repo.
// Cada prueba afirma el comportamiento SEGURO esperado: si falla, es un hallazgo (tasks.md, T16b).
// Solo llaves de prueba generadas al vuelo (directorio temporal) o el fixture `mock`; nunca se imprimen.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generarKek } from "./cli/kek-generar";
import { raizRepo } from "./comun/raiz";
import { CryptoError, crearKeyWrapper } from "./index";
import { crearKeyUnwrapper } from "./descifrado";
import {
  borrarDir,
  capturarError,
  crearDirTemporal,
  generarParRsa,
  type ParLocal,
} from "./soporte-pruebas";

// Captura cada DEK que devuelve privateDecrypt (la única primitiva que desenvuelve DEKs).
const espia = vi.hoisted(() => ({ deks: [] as Buffer[] }));
vi.mock("node:crypto", async (original) => {
  const real = await original<typeof import("node:crypto")>();
  const privateDecrypt = ((...a: unknown[]) => {
    const r = (real.privateDecrypt as (...x: unknown[]) => Buffer)(...a);
    espia.deks.push(r);
    return r;
  }) as typeof real.privateDecrypt;
  return { ...real, privateDecrypt, default: { ...real, privateDecrypt } };
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let dir: string;
let k1: ParLocal;

beforeAll(async () => {
  dir = await crearDirTemporal();
  k1 = await generarParRsa(dir, "r2b-k1");
});

afterAll(async () => {
  if (dir) await borrarDir(dir);
});

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("T16b · KeyProvider más lento que el plazo", () => {
  it("si la privada llega después del plazo, unwrap da KeyProviderError y la DEK desenvuelta tarde queda en ceros", async () => {
    const wrapper = crearKeyWrapper({
      KEY_PROVIDER: "local",
      KEK_ID: "r2b-k1",
      KEK_PUBLIC_KEY_PATH: k1.rutaPublica,
      NODE_ENV: "test",
    });
    const envuelta = await wrapper.wrap(randomBytes(32));
    const pem = Buffer.from(k1.privadaPem ?? "", "utf8");
    expect(pem.length).toBeGreaterThan(100);
    const lento = crearKeyUnwrapper(
      { KEY_PROVIDER: "local", KEK_ID: "r2b-k1", KEK_PRIVATE_KEY_PATH: k1.rutaPrivada, NODE_ENV: "test" },
      { plazoMs: 40, leerArchivo: () => esperar(200).then(() => Buffer.from(pem)) },
    );
    espia.deks.length = 0;
    const error = await capturarError(() => lento.unwrap(envuelta, "r2b-k1"));
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).codigo).toBe("key_provider");
    expect((error as CryptoError).reintentable).toBe(true);
    // La carga lenta termina después: lo que se haya desenvuelto sin dueño debe quedar borrado.
    await esperar(600);
    const vivas = espia.deks.filter((d) => d.some((b) => b !== 0)).length;
    expect(vivas, `DEK desenvuelta tras vencer el plazo quedó en memoria sin borrar (${espia.deks.length} desenvueltas)`).toBe(0);
  });
});

describe("T16b · mock con NODE_ENV de producción escrito de otra forma", () => {
  it.each(["Production", "PRODUCTION", "production ", " production"])(
    "KEY_PROVIDER=mock con NODE_ENV=%j no arranca (backend y worker)",
    (nodeEnv) => {
      const env = { KEY_PROVIDER: "mock", NODE_ENV: nodeEnv };
      let errores = 0;
      for (const crear of [() => crearKeyWrapper(env), () => crearKeyUnwrapper(env)]) {
        try {
          crear();
        } catch (e) {
          if (e instanceof CryptoError && e.codigo === "configuracion") errores += 1;
        }
      }
      expect(errores, "mock arrancó con un NODE_ENV que denota producción").toBe(2);
    },
  );
});

describe("T16b · carga de llaves en local", () => {
  it("privada/pública no RSA (ed25519, x25519, RSA-PSS 4096) o ruta con `..` al fixture mock: error de configuración, no reintentable", async () => {
    const pems = {
      ed25519: generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      }),
      x25519: generateKeyPairSync("x25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      }),
      "rsa-pss": generateKeyPairSync("rsa-pss", {
        modulusLength: 4096,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      }),
    };
    const fallos: string[] = [];
    const exigirConfiguracion = async (nombre: string, fn: () => Promise<unknown>) => {
      const e = await capturarError(fn).catch(() => undefined);
      if (!(e instanceof CryptoError) || e.codigo !== "configuracion" || e.reintentable) {
        fallos.push(`${nombre}: ${(e as CryptoError | undefined)?.codigo ?? "aceptada"}`);
      }
    };
    for (const [nombre, par] of Object.entries(pems)) {
      const priv = join(dir, `${nombre}-private.pem`);
      const pub = join(dir, `${nombre}-public.pem`);
      await writeFile(priv, par.privateKey, { mode: 0o600 });
      await writeFile(pub, par.publicKey, { mode: 0o644 });
      await exigirConfiguracion(`worker ${nombre}`, () =>
        crearKeyUnwrapper({ KEY_PROVIDER: "local", KEK_ID: "r2b-x", KEK_PRIVATE_KEY_PATH: priv, NODE_ENV: "test" }).verificar(),
      );
      await exigirConfiguracion(`backend ${nombre}`, () =>
        crearKeyWrapper({ KEY_PROVIDER: "local", KEK_ID: "r2b-x", KEK_PUBLIC_KEY_PATH: pub, NODE_ENV: "test" }).verificar(),
      );
    }
    // Ruta relativa con `..` que termina en la privada del fixture mock (se resuelve contra la raíz).
    const rodeo = "secrets/../packages/crypto/src/../fixtures/mock-kek/./SOLO-PRUEBAS-kek-mock-private.pem";
    await exigirConfiguracion("worker ruta con ..", () =>
      crearKeyUnwrapper({ KEY_PROVIDER: "local", KEK_ID: "r2b-x", KEK_PRIVATE_KEY_PATH: rodeo, NODE_ENV: "test" }).verificar(),
    );
    expect(fallos).toEqual([]);
  });
});

describe("T16b · kek:generar fuera de una carpeta ignorada por git", () => {
  it("no deja una llave privada en una carpeta del repo que git no ignora (CA-11)", async () => {
    const raiz = raizRepo();
    const relativa = `packages/crypto/r2b-kek-${randomBytes(4).toString("hex")}`;
    const absoluta = join(raiz, relativa);
    let ignorada = true;
    try {
      execFileSync("git", ["check-ignore", "-q", `${relativa}/kek-private.pem`], { cwd: raiz, stdio: "ignore" });
    } catch {
      ignorada = false; // código 1: git NO la ignora (precondición del ataque)
    }
    expect(ignorada, "precondición: la carpeta de prueba no debería estar ignorada").toBe(false);
    try {
      await generarKek({ salida: relativa }, { log: () => undefined }).catch(() => undefined);
      expect(
        existsSync(join(absoluta, "kek-private.pem")),
        "kek:generar escribió una privada en una carpeta versionable del repo",
      ).toBe(false);
    } finally {
      await rm(absoluta, { recursive: true, force: true });
    }
  });
});
