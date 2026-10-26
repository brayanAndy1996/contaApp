import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generarToken, hashToken, tokenConFormatoValido } from "./token.js";

// D2 / CA-5 / CA-6 (spec 004). Contrato (plan: Decisiones: Token y cookie):
//   generarToken(): string            // 32 B de randomBytes en base64url: 43 caracteres, sin relleno
//   tokenConFormatoValido(s: unknown): s is string   // exactamente 43 caracteres de [A-Za-z0-9_-]
//   hashToken(token: string): Buffer  // SHA-256 (32 B) del texto del token (UTF-8); es lo único que
//                                     // se guarda en BD (sesion.token_hash, token_recuperacion.token_hash)
describe("generarToken", () => {
  it("es base64url de 43 caracteres que decodifica a 32 bytes", () => {
    const t = generarToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(Buffer.from(t, "base64url").toString("base64url")).toBe(t);
  });

  it("no repite valores en 2000 llamadas (CSPRNG)", () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 2000; i++) vistos.add(generarToken());
    expect(vistos.size).toBe(2000);
  });

  it("el alfabeto no se limita a unos pocos caracteres (no es un contador ni una constante)", () => {
    const caracteres = new Set<string>();
    for (let i = 0; i < 200; i++) for (const c of generarToken()) caracteres.add(c);
    expect(caracteres.size).toBeGreaterThan(40);
  });
});

describe("tokenConFormatoValido", () => {
  it("acepta un token generado", () => {
    expect(tokenConFormatoValido(generarToken())).toBe(true);
  });

  it.each([
    ["42 caracteres", "A".repeat(42)],
    ["44 caracteres", "A".repeat(44)],
    ["vacío", ""],
    ["con relleno '='", "A".repeat(42) + "="],
    ["alfabeto base64 estándar '+'", "A".repeat(42) + "+"],
    ["alfabeto base64 estándar '/'", "A".repeat(42) + "/"],
    ["con espacio", "A".repeat(42) + " "],
    ["con salto de línea", "A".repeat(42) + "\n"],
    ["con carácter no ASCII", "A".repeat(42) + "é"],
    ["con comilla", "A".repeat(42) + "'"],
  ])("rechaza %s", (_n, valor) => {
    expect(tokenConFormatoValido(valor)).toBe(false);
  });

  it.each([[undefined], [null], [123], [["A".repeat(43)]], [{}]])(
    "rechaza un valor que no es cadena (%j)",
    (valor) => {
      expect(tokenConFormatoValido(valor)).toBe(false);
    },
  );
});

describe("hashToken (CA-6: en BD solo queda el hash)", () => {
  it("es el SHA-256 del texto del token: 32 bytes", () => {
    const t = generarToken();
    const h = hashToken(t);
    expect(Buffer.isBuffer(h)).toBe(true);
    expect(h).toHaveLength(32);
    expect(h.equals(createHash("sha256").update(t, "utf8").digest())).toBe(true);
  });

  it("es determinista y distinto para tokens distintos", () => {
    const a = generarToken();
    const b = generarToken();
    expect(hashToken(a).equals(hashToken(a))).toBe(true);
    expect(hashToken(a).equals(hashToken(b))).toBe(false);
  });

  it("el hash no contiene el token", () => {
    const t = generarToken();
    expect(hashToken(t).toString("utf8")).not.toContain(t);
    expect(hashToken(t).toString("hex")).not.toContain(t);
    expect(hashToken(t).toString("base64url")).not.toBe(t);
  });
});
