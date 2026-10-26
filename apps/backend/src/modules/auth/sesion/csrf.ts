import { createHash, timingSafeEqual } from "node:crypto";

// D6: el token CSRF se deriva del token de sesión (no se guarda en BD y rota con la sesión).
const PREFIJO = "contapp-csrf|v1|";

export function derivarCsrf(tokenSesion: string): string {
  return createHash("sha256").update(`${PREFIJO}${tokenSesion}`, "utf8").digest("base64url");
}

/** Comparación en tiempo constante; un valor que no es cadena o de otra longitud da false. */
export function csrfValido(tokenSesion: string, recibido: unknown): boolean {
  if (typeof recibido !== "string") return false;
  const esperado = Buffer.from(derivarCsrf(tokenSesion), "utf8");
  const dado = Buffer.from(recibido, "utf8");
  if (dado.length !== esperado.length) return false;
  return timingSafeEqual(esperado, dado);
}
