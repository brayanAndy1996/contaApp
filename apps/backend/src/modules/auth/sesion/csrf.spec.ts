import { createHash, timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { derivarCsrf, csrfValido } from "./csrf.js";

// D6 / CA-7 (spec 004). Contrato (plan: Decisiones: CSRF):
//   derivarCsrf(tokenSesion): string = base64url(SHA-256("contapp-csrf|v1|" + tokenSesion))
//     (43 caracteres; no se guarda en BD, rota con la sesión)
//   csrfValido(tokenSesion, recibido: unknown): boolean
//     compara derivarCsrf(tokenSesion) con `recibido` usando crypto.timingSafeEqual sobre
//     buffers de igual longitud; cualquier valor que no sea cadena, o de otra longitud, da false
//     sin lanzar.
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  const espia = vi.fn(real.timingSafeEqual);
  return { ...real, timingSafeEqual: espia, default: { ...real, timingSafeEqual: espia } };
});

const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";
const OTRO = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU";
const esperadoPara = (t: string) =>
  createHash("sha256").update(`contapp-csrf|v1|${t}`).digest("base64url");

beforeEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
});

describe("derivarCsrf", () => {
  it("es base64url(SHA-256('contapp-csrf|v1|' + token)), de 43 caracteres", () => {
    const c = derivarCsrf(TOKEN);
    expect(c).toBe(esperadoPara(TOKEN));
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("es determinista, distinto del token y distinto para otro token (rota con la sesión)", () => {
    expect(derivarCsrf(TOKEN)).toBe(derivarCsrf(TOKEN));
    expect(derivarCsrf(TOKEN)).not.toBe(TOKEN);
    expect(derivarCsrf(TOKEN)).not.toBe(derivarCsrf(OTRO));
  });

  it("no es el SHA-256 del token a secas (lleva el prefijo de dominio)", () => {
    const plano = createHash("sha256").update(TOKEN).digest("base64url");
    expect(derivarCsrf(TOKEN)).not.toBe(plano);
  });
});

describe("csrfValido (CA-7)", () => {
  it("acepta el valor derivado de la sesión y usa timingSafeEqual", () => {
    expect(csrfValido(TOKEN, derivarCsrf(TOKEN))).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("rechaza el valor derivado de otra sesión usando timingSafeEqual (igual longitud)", () => {
    expect(csrfValido(TOKEN, derivarCsrf(OTRO))).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("rechaza un valor de igual longitud alterado en el último carácter", () => {
    const bueno = derivarCsrf(TOKEN);
    const alterado = bueno.slice(0, -1) + (bueno.endsWith("A") ? "B" : "A");
    expect(csrfValido(TOKEN, alterado)).toBe(false);
  });

  it("rechaza el token de sesión usado como CSRF", () => {
    expect(csrfValido(TOKEN, TOKEN)).toBe(false);
  });

  it.each([
    ["vacío", ""],
    ["más corto", "abc"],
    ["más largo", "A".repeat(200)],
    ["un carácter más", derivarCsrf(TOKEN) + "A"],
    ["un carácter menos", derivarCsrf(TOKEN).slice(0, -1)],
  ])("longitud distinta (%s) -> false sin lanzar", (_n, valor) => {
    expect(() => csrfValido(TOKEN, valor)).not.toThrow();
    expect(csrfValido(TOKEN, valor)).toBe(false);
  });

  it.each([[undefined], [null], [123], [["x"]], [{}], [Buffer.from("x")]])(
    "un valor que no es cadena (%j) -> false sin lanzar",
    (valor) => {
      expect(() => csrfValido(TOKEN, valor)).not.toThrow();
      expect(csrfValido(TOKEN, valor)).toBe(false);
    },
  );

  it("un arreglo con el valor correcto (cabecera repetida) no se acepta", () => {
    expect(csrfValido(TOKEN, [derivarCsrf(TOKEN)])).toBe(false);
  });
});
