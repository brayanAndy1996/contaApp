import { describe, expect, it } from "vitest";
import {
  ConfiguracionKeyProviderError,
  IntegridadError,
  KekDesconocidaError,
  KeyProviderError,
  MockKeyProvider as MockWrapper,
  cifrarCredencial,
  crearKeyWrapper,
} from "./index";
import {
  MockKeyProvider as MockCompleto,
  crearKeyUnwrapper,
  descifrarSobre,
} from "./descifrado";
import { VALOR_SOL, ctxSol, esperarFalla, voltearBit } from "./soporte-pruebas";

// CA-10 (modos, parte mock y entorno), CA-7 (proveedor caído, simulado con mock) y CA-4a (parte mock).
const ENV_MOCK = { KEY_PROVIDER: "mock" };

describe("CA-10 KEY_PROVIDER obligatorio y cerrado (impide arrancar)", () => {
  const malos: Array<[string, Record<string, string | undefined>]> = [
    ["ausente", {}],
    ["vacío", { KEY_PROVIDER: "" }],
    ["solo espacios", { KEY_PROVIDER: "  " }],
    ["desconocido (aws)", { KEY_PROVIDER: "aws" }],
    ["desconocido (kms)", { KEY_PROVIDER: "kms" }],
    ["mayúsculas (MOCK)", { KEY_PROVIDER: "MOCK" }],
  ];

  it.each(malos)(
    "crearKeyWrapper con KEY_PROVIDER %s -> ConfiguracionKeyProviderError síncrono",
    (_nombre, env) => {
      expect(() => crearKeyWrapper(env)).toThrow(ConfiguracionKeyProviderError);
    },
  );

  it.each(malos)(
    "crearKeyUnwrapper con KEY_PROVIDER %s -> ConfiguracionKeyProviderError síncrono",
    (_nombre, env) => {
      expect(() => crearKeyUnwrapper(env)).toThrow(
        ConfiguracionKeyProviderError,
      );
    },
  );

  it("el error de configuración no es reintentable", () => {
    let error: unknown;
    try {
      crearKeyWrapper({ KEY_PROVIDER: "aws" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfiguracionKeyProviderError);
    expect((error as ConfiguracionKeyProviderError).reintentable).toBe(false);
  });

  it("mock no arranca con NODE_ENV=production (backend y worker)", () => {
    const env = { KEY_PROVIDER: "mock", NODE_ENV: "production" };
    expect(() => crearKeyWrapper(env)).toThrow(ConfiguracionKeyProviderError);
    expect(() => crearKeyUnwrapper(env)).toThrow(ConfiguracionKeyProviderError);
  });

  it.each(["development", "test", "", undefined])(
    "mock sí arranca con NODE_ENV=%j",
    (nodeEnv) => {
      const env = { KEY_PROVIDER: "mock", NODE_ENV: nodeEnv };
      expect(() => crearKeyWrapper(env)).not.toThrow();
      expect(() => crearKeyUnwrapper(env)).not.toThrow();
    },
  );
});

describe("CA-10 local: variable requerida faltante impide arrancar", () => {
  it("backend sin KEK_ID", () => {
    expect(() =>
      crearKeyWrapper({
        KEY_PROVIDER: "local",
        KEK_PUBLIC_KEY_PATH: "./secrets/kek-public.pem",
      }),
    ).toThrow(ConfiguracionKeyProviderError);
  });

  it("backend sin KEK_PUBLIC_KEY_PATH", () => {
    expect(() =>
      crearKeyWrapper({ KEY_PROVIDER: "local", KEK_ID: "k1" }),
    ).toThrow(ConfiguracionKeyProviderError);
  });

  it("worker sin KEK_ID", () => {
    expect(() =>
      crearKeyUnwrapper({
        KEY_PROVIDER: "local",
        KEK_PRIVATE_KEY_PATH: "./secrets/kek-private.pem",
      }),
    ).toThrow(ConfiguracionKeyProviderError);
  });

  it("worker sin KEK_PRIVATE_KEY_PATH", () => {
    expect(() =>
      crearKeyUnwrapper({ KEY_PROVIDER: "local", KEK_ID: "k1" }),
    ).toThrow(ConfiguracionKeyProviderError);
  });

  it("KEK_ID = mock está reservado y local no lo acepta", () => {
    expect(() =>
      crearKeyWrapper({
        KEY_PROVIDER: "local",
        KEK_ID: "mock",
        KEK_PUBLIC_KEY_PATH: "./secrets/kek-public.pem",
      }),
    ).toThrow(ConfiguracionKeyProviderError);
    expect(() =>
      crearKeyUnwrapper({
        KEY_PROVIDER: "local",
        KEK_ID: "mock",
        KEK_PRIVATE_KEY_PATH: "./secrets/kek-private.pem",
      }),
    ).toThrow(ConfiguracionKeyProviderError);
  });

  it.each(["K 1", "../k", "K1", "", "-k1", "k".repeat(64)])(
    "KEK_ID mal formado %j -> ConfiguracionKeyProviderError",
    async (kekId) => {
      await esperarFalla(async () => {
        const w = crearKeyWrapper({
          KEY_PROVIDER: "local",
          KEK_ID: kekId,
          KEK_PUBLIC_KEY_PATH: "./secrets/kek-public.pem",
        });
        await w.verificar();
      }, ConfiguracionKeyProviderError);
    },
  );
});

describe("CA-4a (mock) la fábrica del backend solo devuelve KeyWrapper", () => {
  it("no expone unwrap ni nada que descifre", () => {
    const w = crearKeyWrapper(ENV_MOCK) as unknown as Record<string, unknown>;
    expect(w.unwrap).toBeUndefined();
    expect("unwrap" in w).toBe(false);
    expect(typeof w.wrap).toBe("function");
    expect(typeof w.verificar).toBe("function");
    expect(w.kekId).toBe("mock");
  });

  it("el MockKeyProvider del punto de entrada de cifrado tampoco expone unwrap", () => {
    const w = new MockWrapper() as unknown as Record<string, unknown>;
    expect(w.unwrap).toBeUndefined();
  });

  it("la fábrica del worker devuelve wrap y unwrap con la misma llave activa", async () => {
    const u = crearKeyUnwrapper(ENV_MOCK);
    expect(u.kekId).toBe("mock");
    const dek = Buffer.alloc(32, 7);
    const envuelta = await u.wrap(Buffer.from(dek));
    expect(envuelta).toHaveLength(512);
    const abierta = await u.unwrap(envuelta, "mock");
    expect(abierta.equals(dek)).toBe(true);
  });

  it("lo envuelto por el backend lo abre el worker (misma DEK)", async () => {
    const dek = Buffer.alloc(32, 9);
    const envuelta = await crearKeyWrapper(ENV_MOCK).wrap(Buffer.from(dek));
    const abierta = await crearKeyUnwrapper(ENV_MOCK).unwrap(envuelta, "mock");
    expect(abierta.equals(dek)).toBe(true);
  });
});

describe("CA-10 mock rechaza sobres de otro kek_id", () => {
  it("unwrap con kekId distinto de mock -> KekDesconocidaError reintentable", async () => {
    const envuelta = await crearKeyWrapper(ENV_MOCK).wrap(Buffer.alloc(32, 1));
    const error = await esperarFalla(
      () => crearKeyUnwrapper(ENV_MOCK).unwrap(envuelta, "k1"),
      KekDesconocidaError,
    );
    expect(error.reintentable).toBe(true);
  });

  it("descifrarSobre con un sobre de kekId k1 y unwrapper mock -> KekDesconocidaError", async () => {
    const sobre = await cifrarCredencial(
      crearKeyWrapper(ENV_MOCK),
      ctxSol(),
      VALOR_SOL,
    );
    await esperarFalla(
      () =>
        descifrarSobre(crearKeyUnwrapper(ENV_MOCK), ctxSol(), {
          ...sobre,
          kekId: "k1",
        }),
      KekDesconocidaError,
    );
  });
});

describe("CA-7 KeyProvider caído (simulado con MockKeyProvider({ falla }))", () => {
  const fallas = ["timeout", "error", "corrupta"] as const;

  it.each(fallas)(
    "backend: wrap con falla %s -> KeyProviderError reintentable",
    async (falla) => {
      const w = new MockWrapper({ falla, plazoMs: 50 });
      const error = await esperarFalla(
        () => w.wrap(Buffer.alloc(32, 1)),
        KeyProviderError,
      );
      expect(error.reintentable).toBe(true);
    },
  );

  it.each(fallas)(
    "backend: cifrarCredencial con falla %s no devuelve sobre (ni parcial) y da KeyProviderError",
    async (falla) => {
      let sobre: unknown;
      await esperarFalla(async () => {
        sobre = await cifrarCredencial(
          new MockWrapper({ falla, plazoMs: 50 }),
          ctxSol(),
          VALOR_SOL,
        );
      }, KeyProviderError);
      expect(sobre).toBeUndefined();
    },
  );

  it.each(fallas)(
    "verificar con falla %s -> KeyProviderError",
    async (falla) => {
      await esperarFalla(
        () => new MockWrapper({ falla, plazoMs: 50 }).verificar(),
        KeyProviderError,
      );
    },
  );

  it("timeout: responde al agotar el plazo, no se cuelga", async () => {
    const t0 = Date.now();
    await esperarFalla(
      () =>
        new MockWrapper({ falla: "timeout", plazoMs: 50 }).wrap(
          Buffer.alloc(32, 1),
        ),
      KeyProviderError,
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it.each(fallas)(
    "worker: unwrap con falla %s -> KeyProviderError reintentable (no IntegridadError)",
    async (falla) => {
      const sobre = await cifrarCredencial(
        crearKeyWrapper(ENV_MOCK),
        ctxSol(),
        VALOR_SOL,
      );
      const caido = new MockCompleto({ falla, plazoMs: 50 });
      const error = await esperarFalla(
        () => descifrarSobre(caido, ctxSol(), sobre),
        KeyProviderError,
      );
      expect(error.reintentable).toBe(true);
      expect(error).not.toBeInstanceOf(IntegridadError);
    },
  );

  it("sin fallas simuladas el mismo proveedor funciona (control)", async () => {
    const sobre = await cifrarCredencial(
      new MockCompleto(),
      ctxSol(),
      VALOR_SOL,
    );
    const secreto = await descifrarSobre(new MockCompleto(), ctxSol(), sobre);
    expect(secreto.usar((v) => v)).toEqual(VALOR_SOL);
  });

  it("la falla simulada solo se activa por constructor, nunca por entorno", async () => {
    const env = {
      KEY_PROVIDER: "mock",
      MOCK_FALLA: "error",
      KEY_PROVIDER_FALLA: "error",
      FALLA: "timeout",
    };
    const w = crearKeyWrapper(env);
    await expect(w.wrap(Buffer.alloc(32, 1))).resolves.toHaveLength(512);
  });

  it("una DEK envuelta alterada con un proveedor sano es IntegridadError, no error de proveedor", async () => {
    const sobre = await cifrarCredencial(
      crearKeyWrapper(ENV_MOCK),
      ctxSol(),
      VALOR_SOL,
    );
    await esperarFalla(
      () =>
        descifrarSobre(crearKeyUnwrapper(ENV_MOCK), ctxSol(), {
          ...sobre,
          dekEnvuelta: voltearBit(sobre.dekEnvuelta, 10, 2),
        }),
      IntegridadError,
    );
  });
});
