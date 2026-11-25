import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Spec 029 (D3, CA-1, CA-2). TOTP de RFC 6238 (HMAC-SHA-1, 6 dígitos, paso de 30 s). Puro: sin IO.

const PASO_MS = 30_000;
const DIGITOS = 6;
const SECRETO_BYTES = 20;
const ALFABETO_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Secreto de 20 bytes de CSPRNG (RFC 4226 §4: ≥ 128 bits; 160 es el estándar de SHA-1). */
export function generarSecretoTotp(): Buffer {
  return randomBytes(SECRETO_BYTES);
}

/** Paso de 30 s que contiene `ahoraMs`. */
export function pasoTotp(ahoraMs: number): number {
  return Math.floor(ahoraMs / PASO_MS);
}

/** Código de 6 dígitos del `paso` (RFC 4226 §5.3, truncado dinámico). */
export function codigoTotp(secreto: Buffer, paso: number): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(paso));
  const h = createHmac("sha1", secreto).update(contador).digest();
  const o = h[h.length - 1]! & 0x0f;
  const n =
    ((h[o]! & 0x7f) << 24) |
    (h[o + 1]! << 16) |
    (h[o + 2]! << 8) |
    h[o + 3]!;
  return String(n % 10 ** DIGITOS).padStart(DIGITOS, "0");
}

/** Base32 de RFC 4648: mayúsculas y sin relleno. */
export function codificarBase32(b: Buffer): string {
  let bits = 0;
  let acumulado = 0;
  let salida = "";
  for (const byte of b) {
    acumulado = (acumulado << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO_BASE32[(acumulado >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acumulado &= (1 << bits) - 1;
  }
  if (bits > 0) salida += ALFABETO_BASE32[(acumulado << (5 - bits)) & 31];
  return salida;
}

/**
 * Verifica un código en la ventana ±1 paso. Devuelve el paso aceptado o `null` (formato inválido, fuera de
 * ventana o paso ≤ `ultimoPaso`: replay, D3). Evalúa siempre los 3 pasos con `timingSafeEqual`, sin cortocircuito.
 */
export function verificarTotp(o: {
  secreto: Buffer;
  codigo: string;
  ahoraMs: number;
  ultimoPaso: number | null;
}): number | null {
  if (typeof o.codigo !== "string" || !/^[0-9]{6}$/.test(o.codigo)) return null;
  const recibido = Buffer.from(o.codigo, "ascii");
  const actual = pasoTotp(o.ahoraMs);
  let aceptado: number | null = null;
  for (const paso of [actual - 1, actual, actual + 1]) {
    const coincide = timingSafeEqual(
      Buffer.from(codigoTotp(o.secreto, paso), "ascii"),
      recibido,
    );
    const nuevo = o.ultimoPaso === null || paso > o.ultimoPaso;
    if (coincide && nuevo && aceptado === null) aceptado = paso;
  }
  return aceptado;
}

/** URI `otpauth://` para el QR (Google Authenticator). La etiqueta y el emisor van con percent-encoding. */
export function uriOtpauth(o: {
  secreto: Buffer;
  correo: string;
  emisor?: string;
}): string {
  const emisor = o.emisor ?? "ContApp";
  const etiqueta = `${encodeURIComponent(emisor)}:${encodeURIComponent(o.correo)}`;
  const consulta = [
    `secret=${codificarBase32(o.secreto)}`,
    `issuer=${encodeURIComponent(emisor)}`,
    "algorithm=SHA1",
    `digits=${DIGITOS}`,
    `period=${PASO_MS / 1000}`,
  ].join("&");
  return `otpauth://totp/${etiqueta}?${consulta}`;
}
