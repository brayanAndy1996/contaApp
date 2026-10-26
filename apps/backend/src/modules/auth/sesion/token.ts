import { createHash, randomBytes } from "node:crypto";

// D2 / D8: token opaco de 32 B (CSPRNG) en base64url (43 caracteres, sin relleno). En BD solo va su
// SHA-256 (CA-6). Lo usan la cookie de sesión y el token de recuperación.
const BYTES_TOKEN = 32;
const FORMATO_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function generarToken(): string {
  return randomBytes(BYTES_TOKEN).toString("base64url");
}

/** Exactamente 43 caracteres base64url; cualquier otra cosa no llega a la BD. */
export function tokenConFormatoValido(valor: unknown): valor is string {
  return typeof valor === "string" && FORMATO_TOKEN.test(valor);
}

/** SHA-256 (32 B) del texto del token en UTF-8: lo único que se guarda en BD. */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
