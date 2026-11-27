import { createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ClaveTotpInvalidaError,
  TotpCifradoError,
  cifrarSecreto,
  descifrarSecreto,
  parsearClaveTotp,
  type ClaveTotp,
} from "./cifrado.js";

// Spec 029 (D1, CA-6). Contrato de `totp/cifrado.ts` (puro, node:crypto, AES-256-GCM):
//   interface ClaveTotp { version: number; clave: Buffer /* 32 B */ }
//   parsearClaveTotp(valor: string): ClaveTotp
//       // «<versión>:<base64 de 32 B>» (TOTP_CLAVE). versión = entero 1..32767. Si es inválida lanza
//       // ClaveTotpInvalidaError; el mensaje NUNCA incluye el valor.
//   cifrarSecreto({ secreto: Buffer, usuarioId: string, clave: ClaveTotp }): { cifrado: Buffer; version: number }
//       // cifrado = iv(12, aleatorio por llamada) ‖ texto cifrado ‖ tag(16); AAD = usuarioId en UTF-8
//   descifrarSecreto({ cifrado, version, usuarioId, claves }): Buffer
//       // usa la clave de `claves` con esa versión (actual o anterior); si falta la versión, el AAD es
//       // otro, el texto está manipulado o es demasiado corto lanza TotpCifradoError («totp_descifrado_fallido»)
const USUARIO = "7b9f0a52-3c1e-4d6a-9a43-5f0c2b7e8d11";
const OTRO_USUARIO = "7b9f0a52-3c1e-4d6a-9a43-5f0c2b7e8d12";
const SECRETO = Buffer.from("12345678901234567890", "ascii");
const clave = (version: number): ClaveTotp => ({
  version,
  clave: randomBytes(32),
});

describe("parsearClaveTotp (D1: TOTP_CLAVE=<versión>:<base64 32 B>)", () => {
  it("lee versión y 32 bytes", () => {
    const bytes = randomBytes(32);
    const c = parsearClaveTotp(`3:${bytes.toString("base64")}`);
    expect(c.version).toBe(3);
    expect(c.clave.equals(bytes)).toBe(true);
  });

  it("acepta la versión 1 y la 32767", () => {
    const b64 = randomBytes(32).toString("base64");
    expect(parsearClaveTotp(`1:${b64}`).version).toBe(1);
    expect(parsearClaveTotp(`32767:${b64}`).version).toBe(32767);
  });

  const b32 = randomBytes(32).toString("base64");
  it.each([
    ["vacía", ""],
    ["sin versión", `:${b32}`],
    ["sin dos puntos", b32],
    ["versión 0", `0:${b32}`],
    ["versión negativa", `-1:${b32}`],
    ["versión no entera", `1.5:${b32}`],
    ["versión con letras", `v1:${b32}`],
    ["versión fuera de rango", `32768:${b32}`],
    ["dos separadores", `1:${b32}:x`],
    ["31 bytes", `1:${randomBytes(31).toString("base64")}`],
    ["33 bytes", `1:${randomBytes(33).toString("base64")}`],
    ["16 bytes", `1:${randomBytes(16).toString("base64")}`],
    ["no es base64", "1:%%%%no-es-base64%%%%"],
    ["clave vacía", "1:"],
  ])("rechaza %s con ClaveTotpInvalidaError", (_n, valor) => {
    expect(() => parsearClaveTotp(valor)).toThrow(ClaveTotpInvalidaError);
  });

  it("el error no incluye el valor ni la parte de la clave (CA-6)", () => {
    const malo = `0:${b32}`;
    let error: unknown;
    try {
      parsearClaveTotp(malo);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ClaveTotpInvalidaError);
    const texto = `${(error as Error).name} ${(error as Error).message} ${String((error as Error).stack)}`;
    expect(texto).not.toContain(b32);
    expect(texto).not.toContain(malo);
  });
});

describe("cifrarSecreto", () => {
  it("devuelve iv(12) ‖ texto(20) ‖ tag(16) = 48 B y la versión de la clave", () => {
    const k = clave(4);
    const r = cifrarSecreto({ secreto: SECRETO, usuarioId: USUARIO, clave: k });
    expect(Buffer.isBuffer(r.cifrado)).toBe(true);
    expect(r.cifrado).toHaveLength(48);
    expect(r.version).toBe(4);
  });

  it("el formato es AES-256-GCM con AAD = usuarioId (se abre con node:crypto a mano)", () => {
    const k = clave(1);
    const { cifrado } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: k,
    });
    const decipher = createDecipheriv(
      "aes-256-gcm",
      k.clave,
      cifrado.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(USUARIO, "utf8"));
    decipher.setAuthTag(cifrado.subarray(cifrado.length - 16));
    const abierto = Buffer.concat([
      decipher.update(cifrado.subarray(12, cifrado.length - 16)),
      decipher.final(),
    ]);
    expect(abierto.equals(SECRETO)).toBe(true);
  });

  it("usa un iv nuevo en cada llamada: el mismo secreto no da el mismo cifrado (200 llamadas)", () => {
    const k = clave(1);
    const ivs = new Set<string>();
    const cifrados = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { cifrado } = cifrarSecreto({
        secreto: SECRETO,
        usuarioId: USUARIO,
        clave: k,
      });
      ivs.add(cifrado.subarray(0, 12).toString("hex"));
      cifrados.add(cifrado.toString("hex"));
    }
    expect(ivs.size).toBe(200);
    expect(cifrados.size).toBe(200);
  });

  it("el secreto en claro no aparece dentro del cifrado (CA-6)", () => {
    const { cifrado } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: clave(1),
    });
    expect(cifrado.includes(SECRETO)).toBe(false);
    expect(cifrado.includes(Buffer.from(USUARIO, "utf8"))).toBe(false);
  });
});

describe("descifrarSecreto", () => {
  it("ida y vuelta con la clave actual", () => {
    const k = clave(2);
    const { cifrado, version } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: k,
    });
    const abierto = descifrarSecreto({
      cifrado,
      version,
      usuarioId: USUARIO,
      claves: [k],
    });
    expect(abierto.equals(SECRETO)).toBe(true);
  });

  it("AAD distinto (otro usuario) falla: el secreto no se puede copiar a otra fila", () => {
    const k = clave(1);
    const { cifrado, version } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: k,
    });
    expect(() =>
      descifrarSecreto({
        cifrado,
        version,
        usuarioId: OTRO_USUARIO,
        claves: [k],
      }),
    ).toThrow(TotpCifradoError);
  });

  it("rotación: una fila cifrada con la versión anterior se abre con [actual, anterior]", () => {
    const anterior = clave(1);
    const actual = clave(2);
    const { cifrado, version } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: anterior,
    });
    expect(version).toBe(1);
    const abierto = descifrarSecreto({
      cifrado,
      version,
      usuarioId: USUARIO,
      claves: [actual, anterior],
    });
    expect(abierto.equals(SECRETO)).toBe(true);
  });

  it("sin la clave de esa versión falla (TOTP_CLAVE_ANTERIOR ausente tras rotar)", () => {
    const anterior = clave(1);
    const actual = clave(2);
    const { cifrado, version } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: anterior,
    });
    expect(() =>
      descifrarSecreto({
        cifrado,
        version,
        usuarioId: USUARIO,
        claves: [actual],
      }),
    ).toThrow(TotpCifradoError);
  });

  it("la versión declarada manda: con otra versión declarada se usa otra clave y falla", () => {
    const v1 = clave(1);
    const v2 = clave(2);
    const { cifrado } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: v1,
    });
    expect(() =>
      descifrarSecreto({
        cifrado,
        version: 2,
        usuarioId: USUARIO,
        claves: [v1, v2],
      }),
    ).toThrow(TotpCifradoError);
  });

  it("la misma versión con otro material de clave falla", () => {
    const { cifrado } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: clave(1),
    });
    expect(() =>
      descifrarSecreto({
        cifrado,
        version: 1,
        usuarioId: USUARIO,
        claves: [clave(1)],
      }),
    ).toThrow(TotpCifradoError);
  });

  it.each([
    ["iv", 0],
    ["texto cifrado", 15],
    ["tag", 40],
  ])("un bit cambiado en el %s falla (GCM autentica todo)", (_n, posicion) => {
    const k = clave(1);
    const { cifrado, version } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: k,
    });
    const roto = Buffer.from(cifrado);
    roto[posicion] = roto[posicion]! ^ 0x01;
    expect(() =>
      descifrarSecreto({
        cifrado: roto,
        version,
        usuarioId: USUARIO,
        claves: [k],
      }),
    ).toThrow(TotpCifradoError);
  });

  it.each([
    ["vacío", 0],
    ["solo el iv", 12],
    ["sin tag completo", 27],
  ])("un cifrado %s lanza TotpCifradoError (no RangeError)", (_n, largo) => {
    const k = clave(1);
    expect(() =>
      descifrarSecreto({
        cifrado: randomBytes(largo),
        version: 1,
        usuarioId: USUARIO,
        claves: [k],
      }),
    ).toThrow(TotpCifradoError);
  });

  it("un cifrado con bytes añadidos falla", () => {
    const k = clave(1);
    const { cifrado, version } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: k,
    });
    const largo = Buffer.concat([cifrado, Buffer.from([0])]);
    expect(() =>
      descifrarSecreto({
        cifrado: largo,
        version,
        usuarioId: USUARIO,
        claves: [k],
      }),
    ).toThrow(TotpCifradoError);
  });

  it("el error no contiene la clave, el secreto ni el cifrado (CA-6)", () => {
    const k = clave(1);
    const { cifrado, version } = cifrarSecreto({
      secreto: SECRETO,
      usuarioId: USUARIO,
      clave: k,
    });
    let error: unknown;
    try {
      descifrarSecreto({
        cifrado,
        version,
        usuarioId: OTRO_USUARIO,
        claves: [k],
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TotpCifradoError);
    const err = error as Error;
    expect(err.name).toBe("TotpCifradoError");
    expect(err.message).toBe("totp_descifrado_fallido");
    const texto = `${err.message} ${String(err.stack)}`;
    for (const secreto of [
      k.clave.toString("base64"),
      k.clave.toString("hex"),
      cifrado.toString("hex"),
      cifrado.toString("base64"),
      SECRETO.toString("ascii"),
    ]) {
      expect(texto).not.toContain(secreto);
    }
  });
});
