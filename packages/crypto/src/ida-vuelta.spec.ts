import { describe, expect, it, vi } from "vitest";
import {
  ContextoAadInvalidoError,
  SecretoInvalidoError,
  SobreInvalidoError,
  cifrarCredencial,
  crearKeyWrapper,
  type CredencialSol,
  type Sobre,
} from "./index";
import { crearKeyUnwrapper, descifrarSobre } from "./descifrado";
import {
  CLIENTE_1,
  VALOR_SIRE,
  VALOR_SOL,
  ctxSire,
  ctxSol,
  esperarFalla,
  wrapperEspia,
} from "./soporte-pruebas";

// CA-1 (ida y vuelta) y CA-2 (nonce y DEK únicos). Proveedor mock: sin BD ni red.
const ENV_MOCK = { KEY_PROVIDER: "mock" };

function backend() {
  return crearKeyWrapper(ENV_MOCK);
}
function worker() {
  return crearKeyUnwrapper(ENV_MOCK);
}

describe("CA-1 ida y vuelta backend (KeyWrapper) -> worker (KeyUnwrapper)", () => {
  it("sol: devuelve usuario y clave exactos", async () => {
    const sobre = await cifrarCredencial(backend(), ctxSol(), VALOR_SOL);
    const secreto = await descifrarSobre(worker(), ctxSol(), sobre);
    expect(secreto.usar((v) => v)).toEqual(VALOR_SOL);
  });

  it("sire_api: devuelve clientId y clientSecret exactos", async () => {
    const sobre = await cifrarCredencial(backend(), ctxSire(), VALOR_SIRE);
    const secreto = await descifrarSobre(worker(), ctxSire(), sobre);
    expect(secreto.usar((v) => v)).toEqual(VALOR_SIRE);
  });

  it("el sobre tiene la forma del contrato (nonce 12 B, tag 16 B, DEK RSA-4096 de 512 B, kekId mock, version 1)", async () => {
    const sobre = await cifrarCredencial(backend(), ctxSol(), VALOR_SOL);
    expect(Buffer.isBuffer(sobre.ciphertext)).toBe(true);
    expect(sobre.ciphertext.length).toBeGreaterThan(0);
    expect(sobre.nonce).toHaveLength(12);
    expect(sobre.tag).toHaveLength(16);
    expect(sobre.dekEnvuelta).toHaveLength(512);
    expect(sobre.kekId).toBe("mock");
    expect(sobre.version).toBe(1);
  });

  it("el sobre no contiene el texto plano", async () => {
    const sobre = await cifrarCredencial(backend(), ctxSol(), VALOR_SOL);
    const todo = Buffer.concat([
      sobre.ciphertext,
      sobre.nonce,
      sobre.tag,
      sobre.dekEnvuelta,
    ]);
    expect(todo.includes(Buffer.from(VALOR_SOL.usuario))).toBe(false);
    expect(todo.includes(Buffer.from(VALOR_SOL.clave))).toBe(false);
  });

  it("unicode (ñ, CJK, emoji, combinantes) vuelve idéntico, sin normalizar", async () => {
    const valor: CredencialSol = {
      usuario: "contador-ñandú-日本語-😀",
      clave: "Clé-é-clave-🔐-Ω≈ç√∫",
    };
    const sobre = await cifrarCredencial(backend(), ctxSol(), valor);
    const secreto = await descifrarSobre(worker(), ctxSol(), sobre);
    const devuelto = secreto.usar((v) => v);
    expect(devuelto.usuario).toBe(valor.usuario);
    expect(devuelto.clave).toBe(valor.clave);
  });

  it("longitud máxima: campos de 256 B UTF-8 (ASCII y multibyte) hacen ida y vuelta", async () => {
    const ascii: CredencialSol = {
      usuario: "u".repeat(256),
      clave: "c".repeat(256),
    };
    const multibyte = {
      clientId: "ñ".repeat(128),
      clientSecret: "é".repeat(128),
    };
    expect(Buffer.byteLength(multibyte.clientId)).toBe(256);
    const s1 = await cifrarCredencial(backend(), ctxSol(), ascii);
    const s2 = await cifrarCredencial(backend(), ctxSire(), multibyte);
    expect(
      (await descifrarSobre(worker(), ctxSol(), s1)).usar((v) => v),
    ).toEqual(ascii);
    expect(
      (await descifrarSobre(worker(), ctxSire(), s2)).usar((v) => v),
    ).toEqual(multibyte);
  });

  it("un campo de 1 B es válido", async () => {
    const sobre = await cifrarCredencial(backend(), ctxSol(), {
      usuario: "a",
      clave: "b",
    });
    const secreto = await descifrarSobre(worker(), ctxSol(), sobre);
    expect(secreto.usar((v) => v)).toEqual({ usuario: "a", clave: "b" });
  });
});

describe("CA-1 el secreto inválido se rechaza al cifrar, sin tocar la llave", () => {
  const casos: Array<[string, unknown]> = [
    ["usuario vacío", { usuario: "", clave: "x" }],
    ["clave vacía", { usuario: "x", clave: "" }],
    ["usuario > 256 B", { usuario: "u".repeat(257), clave: "x" }],
    ["clave > 256 B", { usuario: "x", clave: "c".repeat(257) }],
    [
      "campo de 65 emojis (65 caracteres pero 260 B)",
      { usuario: "😀".repeat(65), clave: "x" },
    ],
    ["sustituto suelto (alto sin bajo)", { usuario: "ab\uD800cd", clave: "x" }],
    ["sustituto suelto (bajo sin alto)", { usuario: "x", clave: "ab\uDC00cd" }],
    [
      "total > 1024 B con cada campo en 256 B (caracteres de control escapados)",
      { usuario: "\u0001".repeat(256), clave: "\u0001".repeat(256) },
    ],
    ["campo ausente", { usuario: "x" }],
    ["campo no string", { usuario: 123, clave: "x" }],
    ["valor nulo", null],
    [
      "tipo de plano distinto de ctx.tipo (par sire_api con ctx sol)",
      VALOR_SIRE,
    ],
  ];

  it.each(casos)(
    "%s -> SecretoInvalidoError y no se llama a wrap",
    async (_nombre, valor) => {
      const { wrapper } = wrapperEspia();
      const espia = vi.spyOn(wrapper, "wrap");
      await esperarFalla(
        () => cifrarCredencial(wrapper, ctxSol(), valor as CredencialSol),
        SecretoInvalidoError,
      );
      expect(espia).not.toHaveBeenCalled();
    },
  );

  it("tipo de plano distinto de ctx.tipo (par sol con ctx sire_api) -> SecretoInvalidoError", async () => {
    await esperarFalla(
      () => cifrarCredencial(backend(), ctxSire(), VALOR_SOL as never),
      SecretoInvalidoError,
    );
  });

  it("el mensaje del error no contiene el valor rechazado", async () => {
    const error = await esperarFalla(
      () =>
        cifrarCredencial(backend(), ctxSol(), {
          usuario: "CANARIO-LARGO-" + "x".repeat(300),
          clave: "y",
        }),
      SecretoInvalidoError,
    );
    expect(error.message).not.toContain("CANARIO-LARGO");
  });

  it("un contexto inválido se rechaza antes de llamar a wrap", async () => {
    const { wrapper } = wrapperEspia();
    const espia = vi.spyOn(wrapper, "wrap");
    await esperarFalla(
      () =>
        cifrarCredencial(
          wrapper,
          ctxSol({ clienteId: CLIENTE_1.toUpperCase() }),
          VALOR_SOL,
        ),
      ContextoAadInvalidoError,
    );
    expect(espia).not.toHaveBeenCalled();
  });
});

describe("CA-2 nonce, DEK y ciphertext únicos (CSPRNG)", () => {
  it("10 000 cifrados del mismo secreto y contexto dan nonces, DEKs y ciphertexts distintos", async () => {
    const { wrapper, deks } = wrapperEspia();
    const nonces = new Set<string>();
    const cifrados = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const s = await cifrarCredencial(wrapper, ctxSol(), VALOR_SOL);
      nonces.add(s.nonce.toString("hex"));
      cifrados.add(s.ciphertext.toString("hex"));
    }
    expect(deks).toHaveLength(10_000);
    expect(new Set(deks).size).toBe(10_000);
    expect(nonces.size).toBe(10_000);
    expect(cifrados.size).toBe(10_000);
    for (const dek of deks) expect(dek).toHaveLength(64); // 32 B
  });

  it("la DEK envuelta y el nonce de dos cifrados del mismo secreto son distintos (mock real)", async () => {
    const a = await cifrarCredencial(backend(), ctxSol(), VALOR_SOL);
    const b = await cifrarCredencial(backend(), ctxSol(), VALOR_SOL);
    expect(a.dekEnvuelta.equals(b.dekEnvuelta)).toBe(false);
    expect(a.nonce.equals(b.nonce)).toBe(false);
  });
});

describe("CA-2 nonce, tag, version o kekId inválidos se rechazan antes de descifrar", () => {
  async function sobreBueno(): Promise<Sobre> {
    return cifrarCredencial(backend(), ctxSol(), VALOR_SOL);
  }
  function unwrapperEspia() {
    const real = worker();
    const unwrap = vi.fn(real.unwrap.bind(real));
    return {
      u: { kekId: real.kekId, unwrap, verificar: real.verificar.bind(real) },
      unwrap,
    };
  }

  it.each([0, 4, 11, 13, 16])(
    "nonce de %i B -> SobreInvalidoError sin llamar a unwrap",
    async (n) => {
      const s = await sobreBueno();
      const { u, unwrap } = unwrapperEspia();
      await esperarFalla(
        () => descifrarSobre(u, ctxSol(), { ...s, nonce: Buffer.alloc(n, 1) }),
        SobreInvalidoError,
      );
      expect(unwrap).not.toHaveBeenCalled();
    },
  );

  it.each([0, 4, 15, 17])(
    "tag de %i B (truncado o extendido) -> SobreInvalidoError sin llamar a unwrap",
    async (n) => {
      const s = await sobreBueno();
      const { u, unwrap } = unwrapperEspia();
      await esperarFalla(
        () => descifrarSobre(u, ctxSol(), { ...s, tag: Buffer.alloc(n, 1) }),
        SobreInvalidoError,
      );
      expect(unwrap).not.toHaveBeenCalled();
    },
  );

  it("version distinta de 1 -> SobreInvalidoError sin llamar a unwrap", async () => {
    const s = await sobreBueno();
    const { u, unwrap } = unwrapperEspia();
    await esperarFalla(
      () => descifrarSobre(u, ctxSol(), { ...s, version: 2 as never }),
      SobreInvalidoError,
    );
    expect(unwrap).not.toHaveBeenCalled();
  });

  it.each(["", "MAL ID", "../x", "k".repeat(64), "-k1"])(
    "kekId mal formado %j -> SobreInvalidoError sin llamar a unwrap",
    async (kekId) => {
      const s = await sobreBueno();
      const { u, unwrap } = unwrapperEspia();
      await esperarFalla(
        () => descifrarSobre(u, ctxSol(), { ...s, kekId }),
        SobreInvalidoError,
      );
      expect(unwrap).not.toHaveBeenCalled();
    },
  );
});
