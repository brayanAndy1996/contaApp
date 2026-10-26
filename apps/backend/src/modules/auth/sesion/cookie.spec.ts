import { describe, expect, it } from "vitest";
import { COOKIE_NOMBRE, construirCookie, cookieBorrada, leerTokenDeCookie } from "./cookie.js";

// D5 / CA-1 / CA-5 (spec 004). Contrato (plan: Decisiones: Token y cookie):
//   COOKIE_NOMBRE = "__Host-contapp_sid"
//   construirCookie(token, maxAgeSegundos): string   // valor del encabezado Set-Cookie
//   cookieBorrada(): string                          // mismo nombre y flags, valor vacío, Max-Age=0
//   leerTokenDeCookie(cabeceraCookie: string | undefined): string | null
//     -> null (sin sesión, sin consultar la BD) si falta, si el token no tiene el formato de 43
//        caracteres base64url, o si el nombre __Host-contapp_sid aparece más de una vez.
const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo"; // 43 caracteres base64url
const OTRO = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU";

const atributos = (setCookie: string) => setCookie.split(";").map((p) => p.trim());

describe("COOKIE_NOMBRE", () => {
  it("lleva el prefijo __Host-", () => {
    expect(COOKIE_NOMBRE).toBe("__Host-contapp_sid");
  });
});

describe("construirCookie (D5)", () => {
  it("emite nombre=token y exactamente los flags de D5", () => {
    const partes = atributos(construirCookie(TOKEN, 43200));
    expect(partes[0]).toBe(`__Host-contapp_sid=${TOKEN}`);
    expect(new Set(partes.slice(1))).toEqual(
      new Set(["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=43200"]),
    );
    expect(partes).toHaveLength(6);
  });

  it("no lleva Domain (exigencia del prefijo __Host-)", () => {
    expect(construirCookie(TOKEN, 100).toLowerCase()).not.toContain("domain");
  });

  it("no lleva Expires ni SameSite distinto de Lax", () => {
    const c = construirCookie(TOKEN, 100).toLowerCase();
    expect(c).not.toContain("expires");
    expect(c).not.toContain("samesite=none");
    expect(c).not.toContain("samesite=strict");
  });

  it("Max-Age es la caducidad absoluta restante recibida", () => {
    expect(atributos(construirCookie(TOKEN, 1))).toContain("Max-Age=1");
    expect(atributos(construirCookie(TOKEN, 7200))).toContain("Max-Age=7200");
    expect(atributos(construirCookie(TOKEN, 43199))).toContain("Max-Age=43199");
  });

  it("Max-Age es un entero (trunca los segundos fraccionarios)", () => {
    const ma = atributos(construirCookie(TOKEN, 100.9)).find((a) => a.startsWith("Max-Age="));
    expect(ma).toMatch(/^Max-Age=\d+$/);
    expect(Number(ma!.slice("Max-Age=".length))).toBeLessThanOrEqual(100);
  });
});

describe("cookieBorrada", () => {
  it("vacía el valor con Max-Age=0 y conserva HttpOnly, Secure, SameSite=Lax y Path=/", () => {
    const partes = atributos(cookieBorrada());
    expect(partes[0]).toBe("__Host-contapp_sid=");
    expect(new Set(partes.slice(1))).toEqual(
      new Set(["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=0"]),
    );
  });

  it("no lleva Domain", () => {
    expect(cookieBorrada().toLowerCase()).not.toContain("domain");
  });
});

describe("leerTokenDeCookie (CA-5)", () => {
  it("lee el token de una cookie válida", () => {
    expect(leerTokenDeCookie(`__Host-contapp_sid=${TOKEN}`)).toBe(TOKEN);
  });

  it("lo encuentra entre otras cookies", () => {
    expect(leerTokenDeCookie(`a=1; __Host-contapp_sid=${TOKEN}; b=2`)).toBe(TOKEN);
    expect(leerTokenDeCookie(`otra=x;__Host-contapp_sid=${TOKEN}`)).toBe(TOKEN);
  });

  it("sin cabecera, vacía o sin la cookie -> null", () => {
    expect(leerTokenDeCookie(undefined)).toBeNull();
    expect(leerTokenDeCookie("")).toBeNull();
    expect(leerTokenDeCookie("a=1; b=2")).toBeNull();
  });

  it("el nombre sin el prefijo __Host- no cuenta", () => {
    expect(leerTokenDeCookie(`contapp_sid=${TOKEN}`)).toBeNull();
    expect(leerTokenDeCookie(`x__Host-contapp_sid=${TOKEN}`)).toBeNull();
    expect(leerTokenDeCookie(`__host-contapp_sid=${TOKEN}`)).toBeNull();
  });

  it("varias cookies __Host-contapp_sid -> null, aunque una sea válida", () => {
    expect(leerTokenDeCookie(`__Host-contapp_sid=${TOKEN}; __Host-contapp_sid=${OTRO}`)).toBeNull();
    expect(leerTokenDeCookie(`__Host-contapp_sid=${TOKEN}; __Host-contapp_sid=${TOKEN}`)).toBeNull();
    expect(leerTokenDeCookie(`__Host-contapp_sid=; __Host-contapp_sid=${TOKEN}`)).toBeNull();
  });

  it.each([
    ["42 caracteres", "A".repeat(42)],
    ["44 caracteres", "A".repeat(44)],
    ["con relleno '='", "A".repeat(42) + "="],
    ["alfabeto estándar '+'", "A".repeat(42) + "+"],
    ["alfabeto estándar '/'", "A".repeat(42) + "/"],
    ["vacío", ""],
    ["con comillas", `"${TOKEN}"`],
  ])("formato inválido (%s) -> null", (_n, valor) => {
    expect(leerTokenDeCookie(`__Host-contapp_sid=${valor}`)).toBeNull();
  });
});
