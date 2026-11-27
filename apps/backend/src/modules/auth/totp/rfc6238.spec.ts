import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Cuenta de llamadas a timingSafeEqual (CA-2: comparación en tiempo constante, sin cortocircuito).
const medida = vi.hoisted(() => ({ llamadas: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  const timingSafeEqual: typeof original.timingSafeEqual = (a, b) => {
    medida.llamadas++;
    return original.timingSafeEqual(a, b);
  };
  return {
    ...original,
    timingSafeEqual,
    default: { ...original, timingSafeEqual },
  };
});

import {
  codificarBase32,
  codigoTotp,
  generarSecretoTotp,
  pasoTotp,
  uriOtpauth,
  verificarTotp,
} from "./rfc6238.js";

// Spec 029 (plan: Archivos y Decisiones; CA-1, CA-2). Contrato de `totp/rfc6238.ts` (puro, node:crypto):
//   generarSecretoTotp(): Buffer                         // 20 B de CSPRNG
//   pasoTotp(ahoraMs: number): number                    // floor(ahoraMs / 30000)
//   codigoTotp(secreto: Buffer, paso: number): string    // RFC 6238, HMAC-SHA-1, 6 dígitos con ceros a la izquierda
//   codificarBase32(b: Buffer): string                   // RFC 4648, mayúsculas, sin relleno
//   verificarTotp({ secreto, codigo, ahoraMs, ultimoPaso }): number | null
//       // ventana ±1 paso; devuelve el paso aceptado o null (formato inválido, fuera de ventana o
//       // paso <= ultimoPaso: replay, D3). Evalúa SIEMPRE los 3 pasos con timingSafeEqual (3 llamadas).
//   uriOtpauth({ secreto, correo, emisor? }): string     // otpauth://totp/<emisor>:<correo>?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30
//                                                        // (emisor por defecto «ContApp»; etiqueta con percent-encoding)
const SECRETO_RFC = Buffer.from("12345678901234567890", "ascii");

beforeEach(() => {
  medida.llamadas = 0;
});

// Implementación de referencia independiente (RFC 4226 §5.3), solo para contrastar con secretos aleatorios.
function referencia(secreto: Buffer, paso: number): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(paso));
  const h = createHmac("sha1", secreto).update(contador).digest();
  const o = h[19]! & 0x0f;
  const v =
    ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(v % 1_000_000).padStart(6, "0");
}

describe("pasoTotp", () => {
  it.each([
    [0, 0],
    [29_999, 0],
    [30_000, 1],
    [59_999, 1],
    [60_000, 2],
    [59_000, 1],
    [1_111_111_109_000, 37_037_036],
  ])("ahoraMs=%d → paso %d (bordes de 30 s)", (ms, paso) => {
    expect(pasoTotp(ms)).toBe(paso);
  });
});

describe("codigoTotp: vectores de RFC 6238 apéndice B (SHA-1, últimos 6 de los 8 dígitos)", () => {
  it.each([
    [59, 1, "287082"], // 94287082
    [1_111_111_109, 37_037_036, "081804"], // 07081804
    [1_111_111_111, 37_037_037, "050471"], // 14050471
    [1_234_567_890, 41_152_263, "005924"], // 89005924
    [2_000_000_000, 66_666_666, "279037"], // 69279037
    [20_000_000_000, 666_666_666, "353130"], // 65353130
  ])("T=%d s (paso %d) → %s", (segundos, paso, esperado) => {
    expect(pasoTotp(segundos * 1000)).toBe(paso);
    expect(codigoTotp(SECRETO_RFC, paso)).toBe(esperado);
  });

  it("conserva los ceros a la izquierda y siempre son 6 dígitos", () => {
    expect(codigoTotp(SECRETO_RFC, 37_037_036)).toBe("081804");
    for (let paso = 0; paso < 300; paso++) {
      expect(codigoTotp(SECRETO_RFC, paso)).toMatch(/^\d{6}$/);
    }
  });

  it("coincide con la implementación de referencia para 25 secretos aleatorios y pasos dispersos", () => {
    for (let i = 0; i < 25; i++) {
      const secreto = generarSecretoTotp();
      const paso = 1_000_000 + i * 7919;
      expect(codigoTotp(secreto, paso)).toBe(referencia(secreto, paso));
    }
  });

  it("un secreto distinto da otro código en el mismo paso (casi siempre: 20 pares)", () => {
    let iguales = 0;
    for (let i = 0; i < 20; i++) {
      if (codigoTotp(generarSecretoTotp(), 5) === codigoTotp(SECRETO_RFC, 5))
        iguales++;
    }
    expect(iguales).toBeLessThan(2);
  });
});

describe("generarSecretoTotp", () => {
  it("son 20 bytes y no se repiten en 500 llamadas", () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const s = generarSecretoTotp();
      expect(Buffer.isBuffer(s)).toBe(true);
      expect(s).toHaveLength(20);
      vistos.add(s.toString("hex"));
    }
    expect(vistos.size).toBe(500);
  });
});

describe("codificarBase32 (RFC 4648 sin relleno)", () => {
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("«%s» → %s", (texto, esperado) => {
    expect(codificarBase32(Buffer.from(texto, "ascii"))).toBe(esperado);
  });

  it("el secreto del RFC (20 B) da 32 caracteres conocidos", () => {
    expect(codificarBase32(SECRETO_RFC)).toBe(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );
  });
});

describe("verificarTotp: ventana ±1 y bordes (CA-2)", () => {
  const paso = 50_000_000;
  const ahoraMs = paso * 30_000 + 12_345; // dentro del paso
  const cod = (p: number) => codigoTotp(SECRETO_RFC, p);
  const verificar = (
    codigo: string,
    ultimoPaso: number | null = null,
    ahora = ahoraMs,
  ) =>
    verificarTotp({ secreto: SECRETO_RFC, codigo, ahoraMs: ahora, ultimoPaso });

  it("acepta el paso actual y devuelve ese paso", () => {
    expect(verificar(cod(paso))).toBe(paso);
  });

  it("acepta el paso anterior y el siguiente (desfase de reloj de ±30 s)", () => {
    expect(verificar(cod(paso - 1))).toBe(paso - 1);
    expect(verificar(cod(paso + 1))).toBe(paso + 1);
  });

  it("rechaza dos pasos atrás y dos adelante", () => {
    expect(verificar(cod(paso - 2))).toBeNull();
    expect(verificar(cod(paso + 2))).toBeNull();
  });

  it("borde: en el último milisegundo del paso y en el primero del siguiente la ventana se desplaza", () => {
    const finDelPaso = (paso + 1) * 30_000 - 1;
    const inicioSiguiente = (paso + 1) * 30_000;
    expect(verificar(cod(paso - 1), null, finDelPaso)).toBe(paso - 1);
    expect(verificar(cod(paso - 1), null, inicioSiguiente)).toBeNull();
    expect(verificar(cod(paso), null, inicioSiguiente)).toBe(paso);
    expect(verificar(cod(paso + 2), null, inicioSiguiente)).toBe(paso + 2);
  });

  it("replay (D3): un paso ya usado o anterior al último aceptado se rechaza", () => {
    expect(verificar(cod(paso), paso)).toBeNull();
    expect(verificar(cod(paso - 1), paso)).toBeNull();
    expect(verificar(cod(paso - 1), paso - 1)).toBeNull();
    expect(verificar(cod(paso + 1), paso)).toBe(paso + 1);
    expect(verificar(cod(paso), paso - 1)).toBe(paso);
    expect(verificar(cod(paso - 1), paso - 2)).toBe(paso - 1);
  });

  it("ultimoPaso null (primer uso) no restringe", () => {
    expect(verificar(cod(paso), null)).toBe(paso);
  });

  it("un código de otro secreto se rechaza", () => {
    const otro = Buffer.from("abcdefghijklmnopqrst", "ascii");
    expect(verificar(codigoTotp(otro, paso))).toBeNull();
  });

  it.each([
    [""],
    ["12345"],
    ["1234567"],
    [" 123456"],
    ["123456 "],
    ["12345a"],
    ["١٢٣٤٥٦"],
    ["123 456"],
    ["123456\n"],
    ["+23456"],
  ])("formato inválido %j → null sin lanzar", (codigo) => {
    expect(verificar(codigo)).toBeNull();
  });

  it.each([[undefined], [null], [123456], [["123456"]], [{}]])(
    "un valor que no es cadena (%j) → null sin lanzar",
    (codigo) => {
      expect(
        verificarTotp({
          secreto: SECRETO_RFC,
          codigo: codigo as unknown as string,
          ahoraMs,
          ultimoPaso: null,
        }),
      ).toBeNull();
    },
  );

  it("un código con ceros a la izquierda se compara como texto de 6 dígitos (sin ceros no coincide)", () => {
    const p = 37_037_036; // código 081804
    expect(
      verificarTotp({
        secreto: SECRETO_RFC,
        codigo: "081804",
        ahoraMs: p * 30_000,
        ultimoPaso: null,
      }),
    ).toBe(p);
    expect(
      verificarTotp({
        secreto: SECRETO_RFC,
        codigo: "81804",
        ahoraMs: p * 30_000,
        ultimoPaso: null,
      }),
    ).toBeNull();
  });
});

describe("verificarTotp: tiempo constante (CA-2)", () => {
  const paso = 50_000_000;
  const ahoraMs = paso * 30_000;

  it("compara con timingSafeEqual los 3 pasos de la ventana aunque el código sea incorrecto", () => {
    const incorrecto =
      codigoTotp(SECRETO_RFC, paso) === "000000" ? "000001" : "000000";
    expect(
      verificarTotp({
        secreto: SECRETO_RFC,
        codigo: incorrecto,
        ahoraMs,
        ultimoPaso: null,
      }),
    ).toBeNull();
    expect(medida.llamadas).toBe(3);
  });

  it("también son 3 comparaciones cuando el primer paso evaluado ya coincide (sin cortocircuito)", () => {
    const codigo = codigoTotp(SECRETO_RFC, paso - 1);
    expect(
      verificarTotp({
        secreto: SECRETO_RFC,
        codigo,
        ahoraMs,
        ultimoPaso: null,
      }),
    ).toBe(paso - 1);
    expect(medida.llamadas).toBe(3);
  });

  it("un replay (paso ya usado) también recorre los 3 pasos", () => {
    const codigo = codigoTotp(SECRETO_RFC, paso);
    expect(
      verificarTotp({
        secreto: SECRETO_RFC,
        codigo,
        ahoraMs,
        ultimoPaso: paso,
      }),
    ).toBeNull();
    expect(medida.llamadas).toBe(3);
  });
});

describe("uriOtpauth (CA-1, CA-6)", () => {
  const secreto = SECRETO_RFC;

  it("arma el URI estándar de Google Authenticator con SHA1, 6 dígitos y 30 s", () => {
    const uri = uriOtpauth({ secreto, correo: "ana@estudio.pe" });
    const u = new URL(uri);
    expect(u.protocol).toBe("otpauth:");
    expect(u.hostname).toBe("totp");
    expect(decodeURIComponent(u.pathname.slice(1))).toBe(
      "ContApp:ana@estudio.pe",
    );
    expect(u.searchParams.get("secret")).toBe(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );
    expect(u.searchParams.get("issuer")).toBe("ContApp");
    expect(u.searchParams.get("algorithm")).toBe("SHA1");
    expect(u.searchParams.get("digits")).toBe("6");
    expect(u.searchParams.get("period")).toBe("30");
  });

  it("acepta un emisor propio y codifica los caracteres especiales de la etiqueta", () => {
    const uri = uriOtpauth({
      secreto,
      correo: "a+b@estudio.pe",
      emisor: "Estudio & Cía",
    });
    const u = new URL(uri);
    expect(decodeURIComponent(u.pathname.slice(1))).toBe(
      "Estudio & Cía:a+b@estudio.pe",
    );
    expect(u.searchParams.get("issuer")).toBe("Estudio & Cía");
    expect(uri).not.toMatch(/\s/);
  });

  it("el secreto va solo en base32 (no en hex ni base64) y no hay parámetros extra", () => {
    const u = new URL(uriOtpauth({ secreto, correo: "ana@estudio.pe" }));
    expect([...u.searchParams.keys()].sort()).toEqual([
      "algorithm",
      "digits",
      "issuer",
      "period",
      "secret",
    ]);
    expect(u.searchParams.get("secret")).toMatch(/^[A-Z2-7]{32}$/);
  });
});
