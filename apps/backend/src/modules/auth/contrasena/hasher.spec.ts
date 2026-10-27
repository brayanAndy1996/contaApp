import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { crearHasher, type Hasher, type LibArgon2 } from "./hasher.js";

// CA-4 / D1 / D9 (spec 004). Contrato (plan: Contratos Backend y Decisiones: Argon2):
//   interface Hasher { calcular(plano): Promise<string>; verificar(phc, plano): Promise<boolean>;
//                      necesitaRehash(phc): boolean; readonly hashFicticio: string }
//   crearHasher(parametros: {memoriaKib, iteraciones, paralelismo}, libreria?: LibArgon2):
//     Promise<Hasher>   // calcula hashFicticio al crearse, con los parametros vigentes
//   LibArgon2 = { hash(plano, opciones): Promise<string>; verify(phc, plano): Promise<boolean> }
//     (la forma de @node-rs/argon2; se inyecta para espiar las llamadas).
// Una contrasena de mas de 128 puntos de codigo se rechaza SIN llamar a la libreria:
// calcular lanza y verificar devuelve false.
// Argon2 real y en el piso (19 MiB, t=2, p=1): cada hash tarda decenas de ms.
const PISO = { memoriaKib: 19456, iteraciones: 2, paralelismo: 1 };
const PLANO = "correcta-caballo-bateria-12";

function espiaLib() {
  const hash = vi.fn(argon2Hash as LibArgon2["hash"]);
  const verify = vi.fn(argon2Verify as LibArgon2["verify"]);
  const lib: LibArgon2 = { hash, verify };
  return { lib, hash, verify };
}

function parsearPhc(phc: string) {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
    phc,
  );
  if (!m) return null;
  return {
    memoria: Number(m[1]),
    iteraciones: Number(m[2]),
    paralelismo: Number(m[3]),
    sal: m[4]!,
    salida: m[5]!,
  };
}

let hasher: Hasher;
let espia: ReturnType<typeof espiaLib>;

beforeAll(async () => {
  espia = espiaLib();
  hasher = await crearHasher(PISO, espia.lib);
});

describe("calcular: formato PHC Argon2id y parámetros (CA-4, D1)", () => {
  it("produce un PHC argon2id v=19", async () => {
    const phc = await hasher.calcular(PLANO);
    expect(parsearPhc(phc)).not.toBeNull();
  });

  it("los parámetros del hash son >= el piso de D1 (m >= 19456, t >= 2, p >= 1)", async () => {
    const p = parsearPhc(await hasher.calcular(PLANO))!;
    expect(p.memoria).toBeGreaterThanOrEqual(19456);
    expect(p.iteraciones).toBeGreaterThanOrEqual(2);
    expect(p.paralelismo).toBeGreaterThanOrEqual(1);
  });

  it("usa los parámetros configurados cuando están sobre el piso", async () => {
    const alto = await crearHasher({ memoriaKib: 24576, iteraciones: 3, paralelismo: 2 });
    const p = parsearPhc(await alto.calcular(PLANO))!;
    expect([p.memoria, p.iteraciones, p.paralelismo]).toEqual([24576, 3, 2]);
  });

  it("dos hashes de la misma contraseña difieren y tienen sal distinta", async () => {
    const a = await hasher.calcular(PLANO);
    const b = await hasher.calcular(PLANO);
    expect(a).not.toBe(b);
    expect(parsearPhc(a)!.sal).not.toBe(parsearPhc(b)!.sal);
  });

  it("la sal es de 16 bytes y la salida de 32 bytes", async () => {
    const p = parsearPhc(await hasher.calcular(PLANO))!;
    expect(Buffer.from(p.sal, "base64")).toHaveLength(16);
    expect(Buffer.from(p.salida, "base64")).toHaveLength(32);
  });

  it("el hash no contiene la contraseña en claro", async () => {
    expect(await hasher.calcular(PLANO)).not.toContain(PLANO);
  });
});

describe("verificar", () => {
  it("acepta la contraseña correcta y rechaza una errónea", async () => {
    const phc = await hasher.calcular(PLANO);
    expect(await hasher.verificar(phc, PLANO)).toBe(true);
    expect(await hasher.verificar(phc, PLANO + "x")).toBe(false);
    expect(await hasher.verificar(phc, "")).toBe(false);
  });

  it("un hash argon2i correcto NO verifica (solo se acepta argon2id)", async () => {
    const argon2i = await argon2Hash(PLANO, {
      algorithm: 1,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    expect(argon2i.startsWith("$argon2i$")).toBe(true);
    expect(await hasher.verificar(argon2i, PLANO)).toBe(false);
  });

  it("un hash argon2d correcto NO verifica", async () => {
    const argon2d = await argon2Hash(PLANO, {
      algorithm: 0,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    expect(argon2d.startsWith("$argon2d$")).toBe(true);
    expect(await hasher.verificar(argon2d, PLANO)).toBe(false);
  });

  it.each([[""], ["texto-que-no-es-phc"], ["$argon2id$basura"], ["$2b$10$abcdefghijklmnopqrstuv"]])(
    "un hash mal formado (%j) da false y no lanza",
    async (phc) => {
      await expect(hasher.verificar(phc, PLANO)).resolves.toBe(false);
    },
  );
});

describe("hashFicticio (D9)", () => {
  it("es un PHC argon2id con los parámetros vigentes", () => {
    const p = parsearPhc(hasher.hashFicticio);
    expect(p).not.toBeNull();
    expect([p!.memoria, p!.iteraciones, p!.paralelismo]).toEqual([19456, 2, 1]);
  });

  it("no verifica ninguna contraseña razonable", async () => {
    for (const candidata of ["", "password1234", PLANO, "admin"]) {
      expect(await hasher.verificar(hasher.hashFicticio, candidata)).toBe(false);
    }
  });

  it("sigue la configuración: con parámetros más altos el ficticio los usa", async () => {
    const alto = await crearHasher({ memoriaKib: 24576, iteraciones: 3, paralelismo: 1 });
    const p = parsearPhc(alto.hashFicticio)!;
    expect([p.memoria, p.iteraciones]).toEqual([24576, 3]);
  });
});

describe("necesitaRehash (CA-4)", () => {
  it("un hash recién calculado con los parámetros vigentes no necesita rehash", async () => {
    expect(hasher.necesitaRehash(await hasher.calcular(PLANO))).toBe(false);
  });

  it.each([
    ["memoria menor", { memoryCost: 8192, timeCost: 2, parallelism: 1 }],
    ["iteraciones menores", { memoryCost: 19456, timeCost: 1, parallelism: 1 }],
    ["memoria e iteraciones menores", { memoryCost: 4096, timeCost: 1, parallelism: 1 }],
  ])("parámetros viejos (%s) -> true", async (_n, opciones) => {
    const viejo = await argon2Hash(PLANO, { algorithm: 2, ...opciones });
    expect(viejo.startsWith("$argon2id$")).toBe(true);
    expect(hasher.necesitaRehash(viejo)).toBe(true);
  });

  it("si se sube la configuración, un hash del piso necesita rehash", async () => {
    const piso = await hasher.calcular(PLANO);
    const subido = await crearHasher({ memoriaKib: 24576, iteraciones: 3, paralelismo: 1 });
    expect(subido.necesitaRehash(piso)).toBe(true);
  });

  it("un hash que no es argon2id (argon2i, argon2d, bcrypt, basura) -> false", async () => {
    const argon2i = await argon2Hash(PLANO, { algorithm: 1, memoryCost: 4096, timeCost: 1 });
    expect(hasher.necesitaRehash(argon2i)).toBe(false);
    expect(hasher.necesitaRehash("$argon2d$v=19$m=4096,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaA")).toBe(
      false,
    );
    expect(hasher.necesitaRehash("$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234")).toBe(
      false,
    );
    expect(hasher.necesitaRehash("")).toBe(false);
    expect(hasher.necesitaRehash("basura")).toBe(false);
  });

  it("no hace cálculo de hash ni verificación (solo lee el PHC)", async () => {
    const e = espiaLib();
    const h = await crearHasher(PISO, e.lib);
    const phc = await argon2Hash(PLANO, { algorithm: 2, memoryCost: 8192, timeCost: 1 });
    e.hash.mockClear();
    e.verify.mockClear();
    h.necesitaRehash(phc);
    expect(e.hash).not.toHaveBeenCalled();
    expect(e.verify).not.toHaveBeenCalled();
  });
});

describe("contraseñas gigantes: rechazo sin llamar a la librería (CA-4, DoS)", () => {
  const casos: Array<[string, string]> = [
    ["129 caracteres", "a".repeat(129)],
    ["129 emojis (258 unidades UTF-16)", "😀".repeat(129)],
    ["1 MB", "a".repeat(1_000_000)],
  ];

  it.each(casos)("calcular(%s) rechaza y no llama a la librería", async (_n, plano) => {
    const e = espiaLib();
    const h = await crearHasher(PISO, e.lib);
    e.hash.mockClear();
    e.verify.mockClear();
    await expect(h.calcular(plano)).rejects.toThrow();
    expect(e.hash).not.toHaveBeenCalled();
    expect(e.verify).not.toHaveBeenCalled();
  });

  it.each(casos)("verificar(%s) da false y no llama a la librería", async (_n, plano) => {
    const e = espiaLib();
    const h = await crearHasher(PISO, e.lib);
    const phc = await h.calcular(PLANO);
    e.hash.mockClear();
    e.verify.mockClear();
    await expect(h.verificar(phc, plano)).resolves.toBe(false);
    expect(e.hash).not.toHaveBeenCalled();
    expect(e.verify).not.toHaveBeenCalled();
  });

  it("128 caracteres sí llegan a la librería (límite inclusivo)", async () => {
    const e = espiaLib();
    const h = await crearHasher(PISO, e.lib);
    e.hash.mockClear();
    const phc = await h.calcular("a".repeat(128));
    expect(e.hash).toHaveBeenCalledTimes(1);
    expect(await h.verificar(phc, "a".repeat(128))).toBe(true);
  });

  it("128 emojis sí llegan a la librería", async () => {
    const e = espiaLib();
    const h = await crearHasher(PISO, e.lib);
    e.hash.mockClear();
    await h.calcular("😀".repeat(128));
    expect(e.hash).toHaveBeenCalledTimes(1);
  });
});

describe("el espía distingue las llamadas (CA-2: una verificación por intento)", () => {
  it("cada verificar llama una sola vez a la librería, con el hash recibido", async () => {
    const e = espiaLib();
    const h = await crearHasher(PISO, e.lib);
    const phc = await h.calcular(PLANO);
    e.verify.mockClear();
    await h.verificar(phc, "otra-contrasena-distinta");
    expect(e.verify).toHaveBeenCalledTimes(1);
    expect(e.verify.mock.calls[0]![0]).toBe(phc);
    await h.verificar(h.hashFicticio, "otra-contrasena-distinta");
    expect(e.verify).toHaveBeenCalledTimes(2);
    expect(e.verify.mock.calls[1]![0]).toBe(h.hashFicticio);
  });
});
