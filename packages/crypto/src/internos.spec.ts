// Pruebas internas de T9 (backend): ramas defensivas que la API pública no alcanza con
// proveedores reales (RNG atascado, permisos POSIX, unwrappers anómalos, CLI).
import {
  createCipheriv,
  generateKeyPairSync,
  publicEncrypt,
  constants,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ConfiguracionKeyProviderError,
  CryptoError,
  IntegridadError,
  KeyProviderError,
  MockKeyProvider as MockWrapper,
  SecretoInvalidoError,
  cifrarCredencial,
  crearKeyWrapper,
  type KeyWrapper,
} from "./index";
import {
  MockKeyProvider as MockCompleto,
  Secreto,
  SecretoDestruidoError,
  crearKeyUnwrapper,
  descifrarSobre,
  reenvolverDek,
  type KeyUnwrapper,
} from "./descifrado";
import { crearGeneradorMaterial, RngNoConfiableError } from "./comun/aleatorio";
import { Perezoso } from "./comun/plazo";
import { raizRepo, resolverRuta } from "./comun/raiz";
import { crearLocalCompleto } from "./descifrado/local";
import { ejecutar, generarKek } from "./cli/kek-generar";
import {
  VALOR_SOL,
  borrarDir,
  crearDirTemporal,
  ctxSol,
  esperarFalla,
  generarParRsa,
  type ParLocal,
} from "./soporte-pruebas";

const ENV_MOCK = { KEY_PROVIDER: "mock" };
const FIXTURE_PUBLICA = resolve(
  __dirname,
  "..",
  "fixtures",
  "mock-kek",
  "SOLO-PRUEBAS-kek-mock-public.pem",
);

let dir: string;
let par: ParLocal;

beforeAll(async () => {
  dir = await crearDirTemporal();
  par = await generarParRsa(dir, "int");
}, 120_000);

afterAll(async () => {
  if (dir) await borrarDir(dir);
});

describe("generador de DEK y nonce", () => {
  it("con un RNG sano entrega 32 B y 12 B", () => {
    const { dek, nonce } = crearGeneradorMaterial()();
    expect(dek).toHaveLength(32);
    expect(nonce).toHaveLength(12);
  });

  it("DEK todo ceros -> RngNoConfiableError", () => {
    const generar = crearGeneradorMaterial((n) => Buffer.alloc(n));
    expect(() => generar()).toThrow(RngNoConfiableError);
  });

  it("DEK repetida -> RngNoConfiableError", () => {
    const fija = randomBytes(32);
    const generar = crearGeneradorMaterial((n) =>
      n === 32 ? Buffer.from(fija) : randomBytes(n),
    );
    generar();
    expect(() => generar()).toThrow(RngNoConfiableError);
  });

  it("nonce repetido -> RngNoConfiableError", () => {
    const fijo = randomBytes(12);
    const generar = crearGeneradorMaterial((n) =>
      n === 12 ? Buffer.from(fijo) : randomBytes(n),
    );
    generar();
    expect(() => generar()).toThrow(RngNoConfiableError);
  });

  // T15 · F5: la guarda recuerda una ventana de huellas, no solo el cifrado anterior.
  const ciclo = (salidas: Buffer[]) => {
    let i = 0;
    return (n: number) => {
      const b = salidas[i++ % salidas.length]!;
      expect(b).toHaveLength(n);
      return Buffer.from(b);
    };
  };
  const A = [Buffer.alloc(32, 1), Buffer.alloc(12, 1)];
  const B = [Buffer.alloc(32, 2), Buffer.alloc(12, 2)];

  it("RNG en ciclo A, B, A -> RngNoConfiableError", () => {
    const generar = crearGeneradorMaterial(ciclo([...A, ...B]));
    generar();
    generar();
    expect(() => generar()).toThrow(RngNoConfiableError);
  });

  it("la ventana es acotada: con capacidad 1, A, B, A ya no se detecta (olvida lo más antiguo)", () => {
    const generar = crearGeneradorMaterial(ciclo([...A, ...B]), 1);
    generar();
    generar();
    expect(generar().dek).toHaveLength(32);
  });
});

describe("Perezoso", () => {
  it("una carga vencida que falla después no borra una carga nueva", async () => {
    let rechazar: (e: Error) => void = () => {};
    let llamadas = 0;
    const perezoso = new Perezoso<number>(() => {
      llamadas += 1;
      if (llamadas === 1) {
        return new Promise<number>((_, r) => {
          rechazar = r;
        });
      }
      return Promise.resolve(7);
    });
    await esperarFalla(() => perezoso.usar((v) => v, 10), KeyProviderError);
    await expect(perezoso.usar((v) => v, 1_000)).resolves.toBe(7);
    rechazar(new Error("tarde"));
    await new Promise((r) => setTimeout(r, 0));
    await expect(perezoso.usar((v) => v, 1_000)).resolves.toBe(7);
    expect(llamadas).toBe(2);
  });

  it("un error ajeno dentro de la operación se normaliza a KeyProviderError", async () => {
    const perezoso = new Perezoso(async () => 1);
    await esperarFalla(
      () =>
        perezoso.usar(() => {
          throw new Error("ajeno");
        }, 1_000),
      KeyProviderError,
    );
  });
});

describe("rutas de llaves", () => {
  it("las relativas se resuelven contra la raíz del repo, no contra el cwd", () => {
    const raiz = raizRepo();
    expect(readFileSync(join(raiz, "pnpm-workspace.yaml"))).toBeTruthy();
    expect(resolverRuta("./secrets/kek-public.pem")).toBe(
      resolve(raiz, "secrets", "kek-public.pem"),
    );
  });

  it("sin pnpm-workspace.yaml hacia arriba se usa el cwd", () => {
    expect(raizRepo(tmpdir())).toBe(process.cwd());
  });
});

describe("configuración de mock", () => {
  it("mock con KEK_ID distinto de mock no arranca", () => {
    expect(() => crearKeyWrapper({ KEY_PROVIDER: "mock", KEK_ID: "k1" })).toThrow(
      ConfiguracionKeyProviderError,
    );
  });

  it("MockKeyProvider no se construye con NODE_ENV=production en el proceso", () => {
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new MockWrapper()).toThrow(ConfiguracionKeyProviderError);
    } finally {
      process.env.NODE_ENV = antes;
    }
  });
});

describe("permisos POSIX de la privada", () => {
  const envolver = (o: Parameters<typeof crearLocalCompleto>[2]) =>
    crearLocalCompleto("k1", par.rutaPrivada, o).verificar();

  it("0600 en POSIX se acepta", async () => {
    await expect(
      envolver({ plataforma: "linux", modoArchivo: () => 0o100600 }),
    ).resolves.toBeUndefined();
  });

  it("legible por grupo u otros -> ConfiguracionKeyProviderError", async () => {
    await esperarFalla(
      () => envolver({ plataforma: "linux", modoArchivo: () => 0o100644 }),
      ConfiguracionKeyProviderError,
    );
  });

  it("si no se puede leer el modo -> KeyProviderError", async () => {
    await esperarFalla(
      () =>
        envolver({
          plataforma: "linux",
          modoArchivo: () => {
            throw new Error("ENOENT");
          },
        }),
      KeyProviderError,
    );
  });

  it("el modo por defecto sale de stat()", async () => {
    const abierta = (statSync(par.rutaPrivada).mode & 0o077) !== 0;
    const resultado = envolver({ plataforma: "linux" });
    if (abierta) {
      await esperarFalla(() => resultado, ConfiguracionKeyProviderError);
    } else {
      await expect(resultado).resolves.toBeUndefined();
    }
  });
});

describe("unwrappers y wrappers anómalos", () => {
  it("un wrapper que lanza un error ajeno da KeyProviderError al cifrar", async () => {
    const w: KeyWrapper = {
      kekId: "mock",
      wrap: () => Promise.reject(new Error("ajeno")),
      verificar: async () => {},
    };
    await esperarFalla(
      () => cifrarCredencial(w, ctxSol(), VALOR_SOL),
      KeyProviderError,
    );
  });

  it("una DEK desenvuelta de largo distinto de 32 B -> IntegridadError", async () => {
    const sobre = await cifrarCredencial(crearKeyWrapper(ENV_MOCK), ctxSol(), VALOR_SOL);
    const u: KeyUnwrapper = {
      kekId: "mock",
      unwrap: async () => Buffer.alloc(16, 1),
      verificar: async () => {},
    };
    await esperarFalla(() => descifrarSobre(u, ctxSol(), sobre), IntegridadError);
  });

  it("el proveedor mock rechaza una DEK envuelta de 16 B con la llave correcta", async () => {
    const envuelta = publicEncrypt(
      {
        key: createPublicKey(readFileSync(FIXTURE_PUBLICA)),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
        oaepLabel: Buffer.from("contapp-kek|v1|mock"),
      },
      Buffer.alloc(16, 3),
    );
    await esperarFalla(
      () => new MockCompleto().unwrap(envuelta, "mock"),
      IntegridadError,
    );
  });

  it("un plano autenticado que no es un secreto canónico -> IntegridadError", async () => {
    const dek = randomBytes(32);
    const nonce = randomBytes(12);
    const ctx = ctxSol();
    const c = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: 16 });
    c.setAAD(Buffer.from(`v1|${ctx.tenantId}|${ctx.clienteId}|sol`));
    const ciphertext = Buffer.concat([c.update(Buffer.from("no es json")), c.final()]);
    const u: KeyUnwrapper = {
      kekId: "mock",
      unwrap: async () => Buffer.from(dek),
      verificar: async () => {},
    };
    await esperarFalla(
      () =>
        descifrarSobre(u, ctx, {
          ciphertext,
          nonce,
          tag: c.getAuthTag(),
          dekEnvuelta: Buffer.alloc(512, 1),
          kekId: "mock",
          version: 1,
        }),
      IntegridadError,
    );
  });

  it("reenvolver: si la activa no abre la DEK igual -> IntegridadError", async () => {
    const sobre = await cifrarCredencial(crearKeyWrapper(ENV_MOCK), ctxSol(), VALOR_SOL);
    const activa = {
      kekId: "k2",
      wrap: async () => Buffer.alloc(512, 2),
      unwrap: async () => randomBytes(32),
      verificar: async () => {},
    };
    await esperarFalla(
      () => reenvolverDek(sobre, crearKeyUnwrapper(ENV_MOCK), activa),
      IntegridadError,
    );
  });

  it("reenvolver: un wrap con error ajeno -> KeyProviderError", async () => {
    const sobre = await cifrarCredencial(crearKeyWrapper(ENV_MOCK), ctxSol(), VALOR_SOL);
    const activa = {
      kekId: "k2",
      wrap: () => Promise.reject(new Error("ajeno")),
      unwrap: async () => randomBytes(32),
      verificar: async () => {},
    };
    await esperarFalla(
      () => reenvolverDek(sobre, crearKeyUnwrapper(ENV_MOCK), activa),
      KeyProviderError,
    );
  });

  it("una llave pública sin módulo (ed25519) se rechaza", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const ruta = join(dir, "ed25519-public.pem");
    await writeFile(ruta, publicKey.export({ type: "spki", format: "pem" }));
    await esperarFalla(
      () =>
        crearKeyWrapper({
          KEY_PROVIDER: "local",
          KEK_ID: "k1",
          KEK_PUBLIC_KEY_PATH: ruta,
        }).verificar(),
      ConfiguracionKeyProviderError,
    );
  });
});

describe("Secreto", () => {
  it("rechaza un plano que no es canónico", () => {
    expect(() => new Secreto("sol", Buffer.from("{}"))).toThrow(
      SecretoInvalidoError,
    );
  });

  it("toString redacta y usar tras destruir lanza SecretoDestruidoError", () => {
    const s = new Secreto(
      "sol",
      Buffer.from(JSON.stringify({ usuario: "a", clave: "b" })),
    );
    expect(s.toString()).toBe("[REDACTADO]");
    s.destruir();
    s.destruir();
    expect(() => s.usar((v) => v)).toThrow(SecretoDestruidoError);
    expect(new SecretoDestruidoError()).toBeInstanceOf(CryptoError);
  });
});

describe("CLI kek:generar", () => {
  it("generarKek sin log no imprime nada y crea el par", async () => {
    const salida = join(dir, "sin-log");
    const escrito = vi.spyOn(process.stdout, "write");
    try {
      const r = await generarKek({ salida });
      expect(r.rutaPrivada).toBe(join(salida, "kek-private.pem"));
      expect(escrito).not.toHaveBeenCalled();
    } finally {
      escrito.mockRestore();
    }
  });

  it("ejecutar devuelve 0 con éxito (ignora el separador --)", async () => {
    const lineas: string[] = [];
    const codigo = await ejecutar(["--", "--salida", join(dir, "via-ejecutar")], {
      log: (l) => lineas.push(l),
    });
    expect(codigo).toBe(0);
    expect(lineas.join("\n")).toContain("kek-private.pem");
  });

  it("ejecutar devuelve 1 con argumentos inválidos y escribe solo el mensaje", async () => {
    const errores: string[] = [];
    expect(await ejecutar(["--otro"], { error: (l) => errores.push(l) })).toBe(1);
    expect(await ejecutar(["--salida"], { error: (l) => errores.push(l) })).toBe(1);
    expect(errores).toHaveLength(2);
    expect(errores[0]).toContain("Uso:");
  });

  it("ejecutar usa stderr por defecto", async () => {
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as never);
    try {
      expect(await ejecutar(["--otro"])).toBe(1);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});
