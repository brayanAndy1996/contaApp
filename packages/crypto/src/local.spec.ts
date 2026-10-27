import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ConfiguracionKeyProviderError,
  IntegridadError,
  KekDesconocidaError,
  KeyProviderError,
  cifrarCredencial,
  crearKeyWrapper,
  type Sobre,
} from "./index";
import {
  MockKeyProvider as MockCompleto,
  crearKeyUnwrapper,
  crearKeyUnwrapperAnterior,
  descifrarSobre,
  reenvolverDek,
} from "./descifrado";
import {
  VALOR_SOL,
  borrarDir,
  crearDirTemporal,
  esperarFalla,
  generarParRsa,
  voltearBit,
  type ParLocal,
  ctxSol,
} from "./soporte-pruebas";

// Proveedor `local` (RSA-OAEP 4096): CA-4a, CA-7 (llave faltante/ilegible/corrupta/timeout), CA-10 (modos),
// llave equivocada (CA-3) y reenvolverDek (base de CA-6). Los pares se generan una vez por archivo.
const FIXTURE = resolve(__dirname, "..", "fixtures", "mock-kek");
const FIXTURE_PUBLICA = join(FIXTURE, "SOLO-PRUEBAS-kek-mock-public.pem");
const FIXTURE_PRIVADA = join(FIXTURE, "SOLO-PRUEBAS-kek-mock-private.pem");

let dir: string;
let k1: ParLocal; // activa original
let k2: ParLocal; // activa tras rotar
let k1bis: ParLocal; // otra llave distinta con el mismo kek_id k1
let rsa2048: ParLocal;
let ecPublica: string;
let ecPrivada: string;
let basura: string;

function envBackend(par: ParLocal, kekId: string, extra = {}) {
  return {
    KEY_PROVIDER: "local",
    KEK_ID: kekId,
    KEK_PUBLIC_KEY_PATH: par.rutaPublica,
    NODE_ENV: "test",
    ...extra,
  };
}
function envWorker(par: ParLocal, kekId: string) {
  return {
    KEY_PROVIDER: "local",
    KEK_ID: kekId,
    KEK_PRIVATE_KEY_PATH: par.rutaPrivada,
    NODE_ENV: "test",
  };
}

beforeAll(async () => {
  dir = await crearDirTemporal();
  [k1, k2, k1bis] = await Promise.all([
    generarParRsa(dir, "k1"),
    generarParRsa(dir, "k2"),
    generarParRsa(dir, "k1bis"),
  ]);
  rsa2048 = await generarParRsa(dir, "rsa2048", 2048);
  const ec = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  ecPublica = join(dir, "ec-public.pem");
  ecPrivada = join(dir, "ec-private.pem");
  basura = join(dir, "basura.pem");
  await writeFile(ecPublica, ec.publicKey);
  await writeFile(ecPrivada, ec.privateKey, { mode: 0o600 });
  await writeFile(basura, "esto no es una llave PEM\n");
}, 240_000);

afterAll(async () => {
  if (dir) await borrarDir(dir);
});

describe("CA-1 / CA-10 ida y vuelta con local (par k1)", () => {
  it("cifra con la pública y descifra con la privada; kekId del sobre es k1", async () => {
    const sobre = await cifrarCredencial(
      crearKeyWrapper(envBackend(k1, "k1")),
      ctxSol(),
      VALOR_SOL,
    );
    expect(sobre.kekId).toBe("k1");
    expect(sobre.dekEnvuelta).toHaveLength(512);
    const secreto = await descifrarSobre(
      crearKeyUnwrapper(envWorker(k1, "k1")),
      ctxSol(),
      sobre,
    );
    expect(secreto.usar((v) => v)).toEqual(VALOR_SOL);
  });

  it("wrap/unwrap devuelven la misma DEK de 32 B", async () => {
    const dek = randomBytes(32);
    const envuelta = await crearKeyWrapper(envBackend(k1, "k1")).wrap(
      Buffer.from(dek),
    );
    const abierta = await crearKeyUnwrapper(envWorker(k1, "k1")).unwrap(
      envuelta,
      "k1",
    );
    expect(abierta.equals(dek)).toBe(true);
  });

  it("la fábrica del worker deriva la pública de la privada (wrap sin KEK_PUBLIC_KEY_PATH)", async () => {
    const u = crearKeyUnwrapper(envWorker(k1, "k1"));
    const dek = randomBytes(32);
    const abierta = await u.unwrap(await u.wrap(Buffer.from(dek)), "k1");
    expect(abierta.equals(dek)).toBe(true);
  });
});

describe("CA-3 llave equivocada", () => {
  it("otra privada con el mismo kek_id -> IntegridadError (no error de proveedor)", async () => {
    const sobre = await cifrarCredencial(
      crearKeyWrapper(envBackend(k1, "k1")),
      ctxSol(),
      VALOR_SOL,
    );
    const error = await esperarFalla(
      () =>
        descifrarSobre(
          crearKeyUnwrapper(envWorker(k1bis, "k1")),
          ctxSol(),
          sobre,
        ),
      IntegridadError,
    );
    expect(error.reintentable).toBe(false);
  });

  it("la DEK envuelta con k1 no se abre reclamando otro kek_id: KekDesconocidaError", async () => {
    const envuelta = await crearKeyWrapper(envBackend(k1, "k1")).wrap(
      randomBytes(32),
    );
    await esperarFalla(
      () => crearKeyUnwrapper(envWorker(k2, "k2")).unwrap(envuelta, "k1"),
      KekDesconocidaError,
    );
  });
});

describe("CA-4a el backend solo abre la llave pública", () => {
  it("local no expone unwrap", () => {
    const w = crearKeyWrapper(envBackend(k1, "k1")) as unknown as Record<
      string,
      unknown
    >;
    expect(w.unwrap).toBeUndefined();
    expect(w.kekId).toBe("k1");
  });

  it("solo se lee la ruta de la pública (leerArchivo espía), aunque la privada esté al lado", async () => {
    const leerArchivo = vi.fn((ruta: string) => readFileSync(ruta));
    const w = crearKeyWrapper(envBackend(k1, "k1"), { leerArchivo });
    await w.verificar();
    await w.wrap(randomBytes(32));
    expect(leerArchivo).toHaveBeenCalled();
    for (const [ruta] of leerArchivo.mock.calls) {
      expect(resolve(ruta)).toBe(resolve(k1.rutaPublica));
      expect(resolve(ruta)).not.toBe(resolve(k1.rutaPrivada));
    }
  });

  it("si el entorno trae KEK_PRIVATE_KEY_PATH no arranca (síncrono, sin leer archivos)", () => {
    const leerArchivo = vi.fn((ruta: string) => readFileSync(ruta));
    expect(() =>
      crearKeyWrapper(
        envBackend(k1, "k1", { KEK_PRIVATE_KEY_PATH: k1.rutaPrivada }),
        { leerArchivo },
      ),
    ).toThrow(ConfiguracionKeyProviderError);
    expect(leerArchivo).not.toHaveBeenCalled();
  });

  it("si el archivo de la 'pública' contiene una privada -> ConfiguracionKeyProviderError", async () => {
    await esperarFalla(async () => {
      const w = crearKeyWrapper({
        ...envBackend(k1, "k1"),
        KEK_PUBLIC_KEY_PATH: k1.rutaPrivada,
      });
      await w.wrap(randomBytes(32));
    }, ConfiguracionKeyProviderError);
  });

  it("la privada de la 'pública' no se usa ni se deja en el mensaje de error", async () => {
    const error = await esperarFalla(async () => {
      const w = crearKeyWrapper({
        ...envBackend(k1, "k1"),
        KEK_PUBLIC_KEY_PATH: k1.rutaPrivada,
      });
      await w.verificar();
    }, ConfiguracionKeyProviderError);
    const cuerpo = k1.privadaPem.split("\n")[2] ?? "";
    expect(cuerpo.length).toBeGreaterThan(20);
    expect(error.message).not.toContain(cuerpo);
    expect(String(error.stack)).not.toContain(cuerpo);
  });
});

describe("CA-10 llaves rechazadas por la fábrica local", () => {
  it("la pública del fixture mock en local -> ConfiguracionKeyProviderError (backend)", async () => {
    await esperarFalla(async () => {
      const w = crearKeyWrapper({
        KEY_PROVIDER: "local",
        KEK_ID: "k1",
        KEK_PUBLIC_KEY_PATH: FIXTURE_PUBLICA,
      });
      await w.wrap(randomBytes(32));
    }, ConfiguracionKeyProviderError);
  });

  it("la privada del fixture mock en local -> ConfiguracionKeyProviderError (worker)", async () => {
    await esperarFalla(async () => {
      const u = crearKeyUnwrapper({
        KEY_PROVIDER: "local",
        KEK_ID: "k1",
        KEK_PRIVATE_KEY_PATH: FIXTURE_PRIVADA,
      });
      await u.verificar();
    }, ConfiguracionKeyProviderError);
  });

  it("llave RSA de 2048 bits (< 4096) se rechaza en backend y worker", async () => {
    await esperarFalla(async () => {
      await crearKeyWrapper(envBackend(rsa2048, "k1")).wrap(randomBytes(32));
    }, ConfiguracionKeyProviderError);
    await esperarFalla(async () => {
      await crearKeyUnwrapper(envWorker(rsa2048, "k1")).verificar();
    }, ConfiguracionKeyProviderError);
  });

  it("llave que no es RSA (EC) se rechaza", async () => {
    await esperarFalla(async () => {
      await crearKeyWrapper({
        KEY_PROVIDER: "local",
        KEK_ID: "k1",
        KEK_PUBLIC_KEY_PATH: ecPublica,
      }).wrap(randomBytes(32));
    }, ConfiguracionKeyProviderError);
    await esperarFalla(async () => {
      await crearKeyUnwrapper({
        KEY_PROVIDER: "local",
        KEK_ID: "k1",
        KEK_PRIVATE_KEY_PATH: ecPrivada,
      }).verificar();
    }, ConfiguracionKeyProviderError);
  });

  it("local rechaza un sobre mock (kekId mock) -> KekDesconocidaError", async () => {
    const sobreMock = await cifrarCredencial(
      crearKeyWrapper({ KEY_PROVIDER: "mock" }),
      ctxSol(),
      VALOR_SOL,
    );
    expect(sobreMock.kekId).toBe("mock");
    await esperarFalla(
      () =>
        descifrarSobre(
          crearKeyUnwrapper(envWorker(k1, "k1")),
          ctxSol(),
          sobreMock,
        ),
      KekDesconocidaError,
    );
  });

  it("mock rechaza un sobre local (kekId k1) -> KekDesconocidaError", async () => {
    const sobreLocal = await cifrarCredencial(
      crearKeyWrapper(envBackend(k1, "k1")),
      ctxSol(),
      VALOR_SOL,
    );
    await esperarFalla(
      () =>
        descifrarSobre(
          crearKeyUnwrapper({ KEY_PROVIDER: "mock" }),
          ctxSol(),
          sobreLocal,
        ),
      KekDesconocidaError,
    );
  });
});

describe("CA-7 local: llave faltante, ilegible, corrupta o proveedor lento", () => {
  it("llave pública inexistente -> KeyProviderError reintentable (wrap y verificar)", async () => {
    const env = {
      ...envBackend(k1, "k1"),
      KEK_PUBLIC_KEY_PATH: join(dir, "no-existe.pem"),
    };
    const e1 = await esperarFalla(
      () => crearKeyWrapper(env).wrap(randomBytes(32)),
      KeyProviderError,
    );
    expect(e1.reintentable).toBe(true);
    await esperarFalla(
      () => crearKeyWrapper(env).verificar(),
      KeyProviderError,
    );
  });

  it("llave ilegible (leerArchivo lanza EACCES) -> KeyProviderError", async () => {
    const leerArchivo = () => {
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    };
    await esperarFalla(
      () =>
        crearKeyWrapper(envBackend(k1, "k1"), { leerArchivo }).wrap(
          randomBytes(32),
        ),
      KeyProviderError,
    );
  });

  it("llave corrupta (no es PEM) -> KeyProviderError reintentable", async () => {
    const error = await esperarFalla(
      () =>
        crearKeyWrapper({
          ...envBackend(k1, "k1"),
          KEK_PUBLIC_KEY_PATH: basura,
        }).wrap(randomBytes(32)),
      KeyProviderError,
    );
    expect(error.reintentable).toBe(true);
  });

  it("llave privada truncada -> KeyProviderError en el worker", async () => {
    const truncada = join(dir, "k1-truncada.pem");
    await writeFile(
      truncada,
      k1.privadaPem.slice(0, Math.floor(k1.privadaPem.length / 2)),
    );
    await esperarFalla(
      () =>
        crearKeyUnwrapper({
          ...envWorker(k1, "k1"),
          KEK_PRIVATE_KEY_PATH: truncada,
        }).verificar(),
      KeyProviderError,
    );
  });

  it("llave privada inexistente -> KeyProviderError en el worker", async () => {
    await esperarFalla(
      () =>
        crearKeyUnwrapper({
          ...envWorker(k1, "k1"),
          KEK_PRIVATE_KEY_PATH: join(dir, "no-existe-private.pem"),
        }).verificar(),
      KeyProviderError,
    );
  });

  it("lectura que nunca termina + plazoMs -> KeyProviderError (timeout), sin colgarse", async () => {
    const leerArchivo = () => new Promise<Buffer>(() => {});
    const t0 = Date.now();
    await esperarFalla(
      () =>
        crearKeyWrapper(envBackend(k1, "k1"), {
          leerArchivo,
          plazoMs: 50,
        }).wrap(randomBytes(32)),
      KeyProviderError,
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("el fallo no se cachea: tras un fallo de lectura, el siguiente intento funciona", async () => {
    let llamadas = 0;
    const leerArchivo = (ruta: string) => {
      llamadas += 1;
      if (llamadas === 1) throw new Error("fallo transitorio");
      return readFileSync(ruta);
    };
    const w = crearKeyWrapper(envBackend(k1, "k1"), { leerArchivo });
    await esperarFalla(() => w.wrap(randomBytes(32)), KeyProviderError);
    await expect(w.wrap(randomBytes(32))).resolves.toHaveLength(512);
  });

  it("no hay fallback a mock: con local caído, cifrarCredencial no devuelve ningún sobre", async () => {
    let sobre: Sobre | undefined;
    await esperarFalla(async () => {
      sobre = await cifrarCredencial(
        crearKeyWrapper({
          ...envBackend(k1, "k1"),
          KEK_PUBLIC_KEY_PATH: join(dir, "no-existe.pem"),
        }),
        ctxSol(),
        VALOR_SOL,
      );
    }, KeyProviderError);
    expect(sobre).toBeUndefined();
  });

  it("worker con llave privada inexistente: descifrarSobre -> KeyProviderError, no IntegridadError", async () => {
    const sobre = await cifrarCredencial(
      crearKeyWrapper(envBackend(k1, "k1")),
      ctxSol(),
      VALOR_SOL,
    );
    const error = await esperarFalla(
      () =>
        descifrarSobre(
          crearKeyUnwrapper({
            ...envWorker(k1, "k1"),
            KEK_PRIVATE_KEY_PATH: join(dir, "no-existe-private.pem"),
          }),
          ctxSol(),
          sobre,
        ),
      KeyProviderError,
    );
    expect(error.reintentable).toBe(true);
  });
});

describe("crearKeyUnwrapperAnterior (solo rotación)", () => {
  it("abre sobres de su kek_id y no expone wrap", async () => {
    const anterior = crearKeyUnwrapperAnterior({
      kekId: "k1",
      rutaPrivada: k1.rutaPrivada,
    }) as unknown as Record<string, unknown>;
    expect(anterior.kekId).toBe("k1");
    expect(anterior.wrap).toBeUndefined();
    const dek = randomBytes(32);
    const envuelta = await crearKeyWrapper(envBackend(k1, "k1")).wrap(
      Buffer.from(dek),
    );
    const abierta = await (
      anterior as unknown as ReturnType<typeof crearKeyUnwrapperAnterior>
    ).unwrap(envuelta, "k1");
    expect(abierta.equals(dek)).toBe(true);
  });

  it("rechaza un kek_id distinto del suyo -> KekDesconocidaError", async () => {
    const anterior = crearKeyUnwrapperAnterior({
      kekId: "k1",
      rutaPrivada: k1.rutaPrivada,
    });
    const envuelta = await crearKeyWrapper(envBackend(k2, "k2")).wrap(
      randomBytes(32),
    );
    await esperarFalla(
      () => anterior.unwrap(envuelta, "k2"),
      KekDesconocidaError,
    );
  });

  it("ruta inexistente -> KeyProviderError al usarla", async () => {
    const anterior = crearKeyUnwrapperAnterior({
      kekId: "k1",
      rutaPrivada: join(dir, "no-existe-private.pem"),
    });
    await esperarFalla(() => anterior.verificar(), KeyProviderError);
  });
});

describe("reenvolverDek (base de CA-6 rotación)", () => {
  const anterior = () =>
    crearKeyUnwrapperAnterior({ kekId: "k1", rutaPrivada: k1.rutaPrivada });
  const activa = () => crearKeyUnwrapper(envWorker(k2, "k2"));
  const sobreK1 = () =>
    cifrarCredencial(
      crearKeyWrapper(envBackend(k1, "k1")),
      ctxSol(),
      VALOR_SOL,
    );

  it("devuelve solo dekEnvuelta y kekId (k2); ciphertext, nonce y tag no se tocan", async () => {
    const s = await sobreK1();
    const r = await reenvolverDek(s, anterior(), activa());
    expect(Object.keys(r).sort()).toEqual(["dekEnvuelta", "kekId"]);
    expect(r.kekId).toBe("k2");
    expect(r.dekEnvuelta).toHaveLength(512);
    expect(r.dekEnvuelta.equals(s.dekEnvuelta)).toBe(false);
  });

  it("el sobre re-envuelto descifra con k2 al mismo secreto, sin tocar el resto del sobre", async () => {
    const s = await sobreK1();
    const r = await reenvolverDek(s, anterior(), activa());
    const nuevo: Sobre = { ...s, ...r };
    expect(nuevo.ciphertext.equals(s.ciphertext)).toBe(true);
    expect(nuevo.nonce.equals(s.nonce)).toBe(true);
    expect(nuevo.tag.equals(s.tag)).toBe(true);
    const secreto = await descifrarSobre(activa(), ctxSol(), nuevo);
    expect(secreto.usar((v) => v)).toEqual(VALOR_SOL);
  });

  it("tras rotar, k1 retirada falla cerrado: el sobre viejo con la activa k2 -> KekDesconocidaError", async () => {
    const s = await sobreK1();
    await esperarFalla(
      () => descifrarSobre(activa(), ctxSol(), s),
      KekDesconocidaError,
    );
  });

  it("el sobre re-envuelto (kekId k2) no lo abre la llave anterior -> KekDesconocidaError", async () => {
    const s = await sobreK1();
    const r = await reenvolverDek(s, anterior(), activa());
    await esperarFalla(
      () => descifrarSobre(anterior(), ctxSol(), { ...s, ...r }),
      KekDesconocidaError,
    );
  });

  it("los cifrados nuevos con la activa usan k2", async () => {
    const nuevo = await cifrarCredencial(activa(), ctxSol(), VALOR_SOL);
    expect(nuevo.kekId).toBe("k2");
  });

  it("reenvolver un sobre que ya está en k2 con la anterior k1 -> KekDesconocidaError (no se pisa)", async () => {
    const s = await sobreK1();
    const r = await reenvolverDek(s, anterior(), activa());
    await esperarFalla(
      () => reenvolverDek({ ...s, ...r }, anterior(), activa()),
      KekDesconocidaError,
    );
  });

  it("kek_id desconocido (ni k1 ni k2) -> KekDesconocidaError", async () => {
    const s = await sobreK1();
    await esperarFalla(
      () => reenvolverDek({ ...s, kekId: "k9" }, anterior(), activa()),
      KekDesconocidaError,
    );
  });

  it("DEK envuelta alterada -> IntegridadError", async () => {
    const s = await sobreK1();
    await esperarFalla(
      () =>
        reenvolverDek(
          { ...s, dekEnvuelta: voltearBit(s.dekEnvuelta, 0, 0) },
          anterior(),
          activa(),
        ),
      IntegridadError,
    );
  });

  it("proveedor activo caído al re-envolver -> KeyProviderError reintentable y no se entrega nada", async () => {
    const s = await sobreK1();
    const caida = new MockCompleto({ falla: "error", plazoMs: 50 });
    let resultado: unknown;
    const error = await esperarFalla(async () => {
      resultado = await reenvolverDek(s, anterior(), caida);
    }, KeyProviderError);
    expect(error.reintentable).toBe(true);
    expect(resultado).toBeUndefined();
  });
});
