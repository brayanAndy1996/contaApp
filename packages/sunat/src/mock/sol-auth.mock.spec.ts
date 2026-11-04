import { describe, expect, it } from "vitest";
import { ErrorCredencial, ErrorTransitorio } from "../errores.js";
import { MockSolAuth } from "./sol-auth.mock.js";
import type { SolAuth } from "../puertos.js";

// Spec 007b (D6; plan: Contratos Puertos), CA-5, CA-6. Contrato fijado por estas pruebas
// (packages/sunat/src/mock/sol-auth.mock.ts, `SOL_PORTAL=mock`):
//  - `new MockSolAuth()` implementa SolAuth: verificar({ruc, usuarioSol, claveSol}) -> Promise<void>
//    (resuelve `undefined`; no devuelve token ni eco de la credencial).
//  - Centinela: `claveSol === "clave-errada"` -> ErrorCredencial (clave SOL rechazada). Cualquier otra
//    clave resuelve. Permite simular «clave errada» con el stack real, sin código.
//  - `fallar(modo: "401" | "timeout" | "5xx" | null, {veces?})` igual que MockSireAuth: "401" ->
//    ErrorCredencial; "timeout" y "5xx" -> ErrorTransitorio; sin `veces`, hasta fallar(null).
//  - `llamadas` (total, incluye fallidas) y `llamadasDe(ruc)`.
//  - Los errores no llevan usuario, clave ni RUC (message fijo): canario en message, String, JSON y stack.
const CANARIO = {
  usuarioSol: "CANARIO-USUARIO-sol",
  claveSol: "CANARIO-SOL-clave",
};
const cred = (ruc: string, extra: Partial<typeof CANARIO> = {}) => ({
  ruc,
  ...CANARIO,
  ...extra,
});
const RUC_A = "20100000001";
const RUC_B = "20100000002";

describe("MockSolAuth", () => {
  it("implementa el puerto SolAuth y resuelve sin valor", async () => {
    const puerto: SolAuth = new MockSolAuth();
    await expect(puerto.verificar(cred(RUC_A))).resolves.toBeUndefined();
  });

  it("acepta cualquier clave que no sea la centinela", async () => {
    const mock = new MockSolAuth();
    for (const claveSol of [
      "x",
      "Clave Con Espacios ",
      "-=@+",
      "CLAVE-ERRADA",
      "clave-errada ",
    ]) {
      await expect(
        mock.verificar(cred(RUC_A, { claveSol })),
      ).resolves.toBeUndefined();
    }
  });

  it("claveSol «clave-errada» -> ErrorCredencial, para cualquier RUC y usuario", async () => {
    const mock = new MockSolAuth();
    await expect(
      mock.verificar(cred(RUC_A, { claveSol: "clave-errada" })),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    await expect(
      mock.verificar(
        cred(RUC_B, { claveSol: "clave-errada", usuarioSol: "OTRO" }),
      ),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    // la centinela no deja el mock envenenado
    await expect(mock.verificar(cred(RUC_A))).resolves.toBeUndefined();
  });

  it("cuenta las llamadas, en total y por RUC, también las que fallan", async () => {
    const mock = new MockSolAuth();
    expect(mock.llamadas).toBe(0);
    await mock.verificar(cred(RUC_A));
    await mock
      .verificar(cred(RUC_A, { claveSol: "clave-errada" }))
      .catch(() => undefined);
    await mock.verificar(cred(RUC_B));
    expect(mock.llamadas).toBe(3);
    expect(mock.llamadasDe(RUC_A)).toBe(2);
    expect(mock.llamadasDe(RUC_B)).toBe(1);
    expect(mock.llamadasDe("20999999999")).toBe(0);
  });

  describe("fallar()", () => {
    it("401 -> ErrorCredencial mientras no se limpie", async () => {
      const mock = new MockSolAuth();
      mock.fallar("401");
      await expect(mock.verificar(cred(RUC_A))).rejects.toBeInstanceOf(
        ErrorCredencial,
      );
      await expect(mock.verificar(cred(RUC_B))).rejects.toBeInstanceOf(
        ErrorCredencial,
      );
      mock.fallar(null);
      await expect(mock.verificar(cred(RUC_A))).resolves.toBeUndefined();
    });

    it.each(["timeout", "5xx"] as const)(
      "%s -> ErrorTransitorio",
      async (modo) => {
        const mock = new MockSolAuth();
        mock.fallar(modo);
        await expect(mock.verificar(cred(RUC_A))).rejects.toBeInstanceOf(
          ErrorTransitorio,
        );
      },
    );

    it("con veces: n falla n llamadas y luego funciona", async () => {
      const mock = new MockSolAuth();
      mock.fallar("timeout", { veces: 2 });
      await expect(mock.verificar(cred(RUC_A))).rejects.toBeInstanceOf(
        ErrorTransitorio,
      );
      await expect(mock.verificar(cred(RUC_A))).rejects.toBeInstanceOf(
        ErrorTransitorio,
      );
      await expect(mock.verificar(cred(RUC_A))).resolves.toBeUndefined();
      expect(mock.llamadas).toBe(3);
    });
  });

  it("los errores no llevan usuario, clave ni RUC (canario)", async () => {
    const mock = new MockSolAuth();
    const errores: unknown[] = [];
    errores.push(
      await mock
        .verificar(cred(RUC_A, { claveSol: "clave-errada" }))
        .catch((x: unknown) => x),
    );
    for (const modo of ["401", "timeout", "5xx"] as const) {
      mock.fallar(modo);
      errores.push(await mock.verificar(cred(RUC_A)).catch((x: unknown) => x));
    }
    for (const e of errores) {
      expect(e).toBeInstanceOf(Error);
      const texto = `${String((e as Error).message)} ${String(e)} ${JSON.stringify(e)} ${String((e as Error).stack)}`;
      expect(texto).not.toContain("CANARIO");
      expect(texto).not.toContain("clave-errada");
      expect(texto).not.toContain(RUC_A);
    }
  });
});
