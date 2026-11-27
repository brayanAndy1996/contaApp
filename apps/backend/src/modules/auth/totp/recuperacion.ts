import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { ClaveTotp } from "./cifrado.js";

// Spec 029 (U4, D1, CA-6, CA-9). Códigos de recuperación y su hash. Puro: sin IO.

const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CANTIDAD = 10;
const INFO_HKDF = Buffer.from("contapp/029/recuperacion/v1", "utf8");

/** Un código: 12 símbolos base32 (5 bits cada uno = 60 bits de CSPRNG) como `XXXX-XXXX-XXXX`. */
function generarUno(): string {
  // 256 es múltiplo de 32: `& 31` no sesga.
  const simbolos = [...randomBytes(12)].map((b) => ALFABETO[b & 31]!);
  return [
    simbolos.slice(0, 4).join(""),
    simbolos.slice(4, 8).join(""),
    simbolos.slice(8, 12).join(""),
  ].join("-");
}

/** 10 códigos distintos. */
export function generarCodigosRecuperacion(): string[] {
  const codigos = new Set<string>();
  while (codigos.size < CANTIDAD) codigos.add(generarUno());
  return [...codigos];
}

/**
 * HMAC-SHA-256 del código con una subclave HKDF-SHA-256 de `clave.clave` (no la clave cruda). Determinista.
 * En BD solo se guarda este hash: sin `TOTP_CLAVE` un volcado no sirve para probar códigos.
 */
export function hashCodigoRecuperacion(codigo: string, clave: ClaveTotp): Buffer {
  const subclave = Buffer.from(
    hkdfSync("sha256", clave.clave, Buffer.alloc(0), INFO_HKDF, 32),
  );
  return createHmac("sha256", subclave).update(codigo, "utf8").digest();
}
