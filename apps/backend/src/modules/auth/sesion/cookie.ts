import { tokenConFormatoValido } from "./token.js";

// D5: cookie `__Host-` (exige Secure, Path=/ y sin Domain), HttpOnly, SameSite=Lax y Max-Age igual a
// la caducidad absoluta restante (la aplica igual el servidor, D3).
export const COOKIE_NOMBRE = "__Host-contapp_sid";

const ATRIBUTOS = "HttpOnly; Secure; SameSite=Lax; Path=/";

export function construirCookie(token: string, maxAgeSegundos: number): string {
  const maxAge = Math.max(0, Math.trunc(maxAgeSegundos));
  return `${COOKIE_NOMBRE}=${token}; ${ATRIBUTOS}; Max-Age=${maxAge}`;
}

export function cookieBorrada(): string {
  return `${COOKIE_NOMBRE}=; ${ATRIBUTOS}; Max-Age=0`;
}

/**
 * Token de la cabecera `Cookie`, o null (sin sesión y sin consultar la BD) si falta, si no tiene el
 * formato de 43 caracteres base64url o si `__Host-contapp_sid` aparece más de una vez.
 */
export function leerTokenDeCookie(cabecera: string | undefined): string | null {
  if (typeof cabecera !== "string" || cabecera === "") return null;
  let valor: string | null = null;
  let vistas = 0;
  for (const par of cabecera.split(";")) {
    const i = par.indexOf("=");
    if (i < 0) continue;
    if (par.slice(0, i).trim() !== COOKIE_NOMBRE) continue;
    vistas += 1;
    valor = par.slice(i + 1).trim();
  }
  if (vistas !== 1) return null;
  return tokenConFormatoValido(valor) ? valor : null;
}
