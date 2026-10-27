import { describe, expect, it } from "vitest";
import { ErrorCredencial, ErrorTransitorio } from "../errores.js";
import { MockSireAuth } from "./sire-auth.mock.js";
import type { SireAuth } from "../puertos.js";

// Contrato (plan 008, packages/sunat/src/mock/sire-auth.mock.ts), CA-11, CA-16:
//  - `new MockSireAuth(opciones?: { ahora?: () => Date; vigenciaMs?: number })` implementa SireAuth.
//    `vigenciaMs` por defecto > 0 (p. ej. 1 h): expiraEn = ahora() + vigenciaMs.
//  - Token DETERMINISTA por RUC y por numero de llamada exitosa de ESE RUC (1, 2, ...): dos
//    instancias nuevas devuelven la misma secuencia para el mismo RUC; el segundo token del RUC es
//    distinto del primero (permite ver una renovacion); RUC distintos -> tokens distintos. El token
//    NUNCA contiene clientSecret, claveSol ni usuarioSol.
//  - `llamadas` (total, incluye las que fallan) y `llamadasDe(ruc)`.
//  - Fallas: `fallar(modo: "401" | "timeout" | "5xx" | null, opciones?: { veces?: number })`.
//    "401" -> ErrorCredencial; "timeout" y "5xx" -> ErrorTransitorio. Sin `veces`: hasta que se
//    llame fallar(null). Con `veces: n`: las siguientes n llamadas fallan y luego vuelve a funcionar.
//    Una llamada que falla cuenta en `llamadas` pero no consume numero de token. El error no lleva
//    datos de entrada (canario).
const CANARIO = {
  clientId: "CANARIO-CLIENT-id",
  clientSecret: "CANARIO-SECRET-xyz",
  usuarioSol: "CANARIO-USUARIO-sol",
  claveSol: "CANARIO-SOL-clave",
};
const cred = (ruc: string) => ({ ...CANARIO, ruc });
const RUC_A = "20100000001";
const RUC_B = "20100000002";
const AHORA = new Date("2026-10-27T15:00:00.000Z");

describe("MockSireAuth", () => {
  it("implementa el puerto SireAuth", async () => {
    const puerto: SireAuth = new MockSireAuth({ ahora: () => AHORA });
    const r = await puerto.obtenerToken(cred(RUC_A));
    expect(typeof r.token).toBe("string");
    expect(r.token.length).toBeGreaterThan(0);
    expect(r.expiraEn).toBeInstanceOf(Date);
  });

  it("expiraEn = ahora + vigenciaMs", async () => {
    const mock = new MockSireAuth({ ahora: () => AHORA, vigenciaMs: 90_000 });
    const r = await mock.obtenerToken(cred(RUC_A));
    expect(r.expiraEn.getTime()).toBe(AHORA.getTime() + 90_000);
  });

  it("la vigencia por defecto es positiva", async () => {
    const mock = new MockSireAuth({ ahora: () => AHORA });
    const r = await mock.obtenerToken(cred(RUC_A));
    expect(r.expiraEn.getTime()).toBeGreaterThan(AHORA.getTime());
  });

  it("es determinista por RUC y por numero de llamada, entre instancias", async () => {
    const m1 = new MockSireAuth({ ahora: () => AHORA });
    const m2 = new MockSireAuth({ ahora: () => AHORA });
    const a1 = (await m1.obtenerToken(cred(RUC_A))).token;
    const a2 = (await m1.obtenerToken(cred(RUC_A))).token;
    expect((await m2.obtenerToken(cred(RUC_A))).token).toBe(a1);
    expect((await m2.obtenerToken(cred(RUC_A))).token).toBe(a2);
    expect(a2).not.toBe(a1); // renovar produce otro token
  });

  it("RUC distintos -> tokens distintos, y cada RUC lleva su propio contador", async () => {
    const mock = new MockSireAuth({ ahora: () => AHORA });
    const a = (await mock.obtenerToken(cred(RUC_A))).token;
    const b = (await mock.obtenerToken(cred(RUC_B))).token;
    expect(a).not.toBe(b);
    // el primer token del RUC B no depende de haber llamado antes con el RUC A
    const solo = new MockSireAuth({ ahora: () => AHORA });
    expect((await solo.obtenerToken(cred(RUC_B))).token).toBe(b);
  });

  it("cuenta las llamadas, en total y por RUC", async () => {
    const mock = new MockSireAuth({ ahora: () => AHORA });
    expect(mock.llamadas).toBe(0);
    await mock.obtenerToken(cred(RUC_A));
    await mock.obtenerToken(cred(RUC_A));
    await mock.obtenerToken(cred(RUC_B));
    expect(mock.llamadas).toBe(3);
    expect(mock.llamadasDe(RUC_A)).toBe(2);
    expect(mock.llamadasDe(RUC_B)).toBe(1);
    expect(mock.llamadasDe("20999999999")).toBe(0);
  });

  it("el token no contiene clientSecret, claveSol ni usuarioSol", async () => {
    const mock = new MockSireAuth({ ahora: () => AHORA });
    const { token } = await mock.obtenerToken(cred(RUC_A));
    for (const secreto of [
      CANARIO.clientSecret,
      CANARIO.claveSol,
      CANARIO.usuarioSol,
    ]) {
      expect(token).not.toContain(secreto);
    }
    expect(token).not.toContain("CANARIO");
  });

  describe("modos de falla", () => {
    it("401 -> ErrorCredencial, mientras no se limpie", async () => {
      const mock = new MockSireAuth({ ahora: () => AHORA });
      mock.fallar("401");
      await expect(mock.obtenerToken(cred(RUC_A))).rejects.toBeInstanceOf(
        ErrorCredencial,
      );
      await expect(mock.obtenerToken(cred(RUC_B))).rejects.toBeInstanceOf(
        ErrorCredencial,
      );
      mock.fallar(null);
      await expect(mock.obtenerToken(cred(RUC_A))).resolves.toHaveProperty(
        "token",
      );
    });

    it.each(["timeout", "5xx"] as const)(
      "%s -> ErrorTransitorio",
      async (modo) => {
        const mock = new MockSireAuth({ ahora: () => AHORA });
        mock.fallar(modo);
        await expect(mock.obtenerToken(cred(RUC_A))).rejects.toBeInstanceOf(
          ErrorTransitorio,
        );
      },
    );

    it("con veces: n falla n llamadas y luego funciona", async () => {
      const mock = new MockSireAuth({ ahora: () => AHORA });
      mock.fallar("401", { veces: 2 });
      await expect(mock.obtenerToken(cred(RUC_A))).rejects.toBeInstanceOf(
        ErrorCredencial,
      );
      await expect(mock.obtenerToken(cred(RUC_A))).rejects.toBeInstanceOf(
        ErrorCredencial,
      );
      await expect(mock.obtenerToken(cred(RUC_A))).resolves.toHaveProperty(
        "token",
      );
    });

    it("las llamadas que fallan cuentan, pero no consumen numero de token", async () => {
      const mock = new MockSireAuth({ ahora: () => AHORA });
      const esperado = (
        await new MockSireAuth({ ahora: () => AHORA }).obtenerToken(cred(RUC_A))
      ).token;
      mock.fallar("timeout", { veces: 1 });
      await expect(mock.obtenerToken(cred(RUC_A))).rejects.toBeInstanceOf(
        ErrorTransitorio,
      );
      expect(mock.llamadas).toBe(1);
      expect((await mock.obtenerToken(cred(RUC_A))).token).toBe(esperado);
      expect(mock.llamadas).toBe(2);
    });

    it("el error no lleva datos de entrada (canario)", async () => {
      const mock = new MockSireAuth({ ahora: () => AHORA });
      for (const modo of ["401", "timeout", "5xx"] as const) {
        mock.fallar(modo);
        const e: unknown = await mock
          .obtenerToken(cred(RUC_A))
          .catch((x: unknown) => x);
        expect(e).toBeInstanceOf(Error);
        const texto = `${String((e as Error).message)} ${String(e)} ${JSON.stringify(e)} ${String((e as Error).stack)}`;
        expect(texto).not.toContain("CANARIO");
        expect(texto).not.toContain(RUC_A);
      }
    });
  });
});
