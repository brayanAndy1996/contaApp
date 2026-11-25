import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClaveTotp } from "./cifrado.js";
import {
  generarCodigosRecuperacion,
  hashCodigoRecuperacion,
} from "./recuperacion.js";

// Spec 029 (U4, D1, CA-6, CA-9). Contrato de `totp/recuperacion.ts` (puro, node:crypto):
//   generarCodigosRecuperacion(): string[]
//       // 10 códigos distintos «XXXX-XXXX-XXXX», alfabeto base32 (A-Z2-7), 60 bits de CSPRNG cada uno
//   hashCodigoRecuperacion(codigo: string, clave: ClaveTotp): Buffer
//       // HMAC-SHA-256 (32 B) con una SUBCLAVE derivada con HKDF-SHA-256 de clave.clave (no la clave
//       // cruda); determinista. En BD solo se guarda este hash (auth.totp_recuperacion.hash).
const FORMATO = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;
const clave = (version = 1): ClaveTotp => ({ version, clave: randomBytes(32) });

describe("generarCodigosRecuperacion (U4)", () => {
  it("devuelve 10 códigos distintos con el formato XXXX-XXXX-XXXX", () => {
    const codigos = generarCodigosRecuperacion();
    expect(codigos).toHaveLength(10);
    expect(new Set(codigos).size).toBe(10);
    for (const c of codigos) expect(c).toMatch(FORMATO);
  });

  it("no repite códigos en 500 lotes (5000 códigos de 60 bits)", () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 500; i++)
      for (const c of generarCodigosRecuperacion()) vistos.add(c);
    expect(vistos.size).toBe(5000);
  });

  it("usa todo el alfabeto base32 (32 símbolos) y no un subconjunto", () => {
    const simbolos = new Set<string>();
    for (let i = 0; i < 100; i++) {
      for (const c of generarCodigosRecuperacion())
        for (const s of c.replaceAll("-", "")) simbolos.add(s);
    }
    expect(simbolos.size).toBe(32);
  });

  it("los 12 símbolos aportan 60 bits: la primera posición también varía (sin prefijo fijo)", () => {
    const primeros = new Set<string>();
    const ultimos = new Set<string>();
    for (let i = 0; i < 100; i++) {
      for (const c of generarCodigosRecuperacion()) {
        primeros.add(c[0]!);
        ultimos.add(c[c.length - 1]!);
      }
    }
    expect(primeros.size).toBeGreaterThan(28);
    expect(ultimos.size).toBeGreaterThan(28);
  });
});

describe("hashCodigoRecuperacion (D1, CA-6, CA-9)", () => {
  const k = clave();
  const CODIGO = "ABCD-EFGH-2345";

  it("son 32 bytes (HMAC-SHA-256) y es determinista", () => {
    const h1 = hashCodigoRecuperacion(CODIGO, k);
    const h2 = hashCodigoRecuperacion(CODIGO, k);
    expect(Buffer.isBuffer(h1)).toBe(true);
    expect(h1).toHaveLength(32);
    expect(h1.equals(h2)).toBe(true);
  });

  it("códigos distintos dan hashes distintos", () => {
    const vistos = new Set<string>();
    for (const c of generarCodigosRecuperacion())
      vistos.add(hashCodigoRecuperacion(c, k).toString("hex"));
    expect(vistos.size).toBe(10);
  });

  it("otra clave da otro hash: un volcado de la tabla no sirve para probar códigos sin TOTP_CLAVE", () => {
    const otra = clave();
    expect(
      hashCodigoRecuperacion(CODIGO, k).equals(
        hashCodigoRecuperacion(CODIGO, otra),
      ),
    ).toBe(false);
  });

  it("no es un hash sin clave del texto (SHA-256 del código)", () => {
    const plano = createHash("sha256").update(CODIGO, "utf8").digest();
    expect(hashCodigoRecuperacion(CODIGO, k).equals(plano)).toBe(false);
  });

  it("no usa la clave de cifrado tal cual como clave del HMAC: se deriva una subclave (HKDF)", () => {
    const crudo = createHmac("sha256", k.clave).update(CODIGO, "utf8").digest();
    const crudoTexto = createHmac("sha256", k.clave.toString("base64"))
      .update(CODIGO, "utf8")
      .digest();
    const h = hashCodigoRecuperacion(CODIGO, k);
    expect(h.equals(crudo)).toBe(false);
    expect(h.equals(crudoTexto)).toBe(false);
  });

  it("el hash no contiene el código en claro", () => {
    const h = hashCodigoRecuperacion(CODIGO, k);
    expect(h.includes(Buffer.from(CODIGO, "utf8"))).toBe(false);
    expect(h.toString("hex")).not.toContain(
      Buffer.from(CODIGO, "utf8").toString("hex"),
    );
  });
});
