import { describe, expect, it } from "vitest";
import { ErrorDatos, ErrorTransitorio } from "../errores.js";
import { MockConsultaRuc } from "./consulta-ruc.mock.js";
import type { ConsultaRuc } from "../puertos.js";

// Spec 007b (D1; plan: Contratos Puertos), CA-6. Contrato fijado por estas pruebas
// (packages/sunat/src/mock/consulta-ruc.mock.ts, `RUC_CLIENT=mock`):
//  - `new MockConsultaRuc()` implementa ConsultaRuc: consultar(ruc) -> {razonSocial, estado, condicion}
//    (los tres strings no vacíos). La razón social NUNCA es la provisional «RUC <ruc>».
//  - DETERMINISTA por RUC: el mismo RUC da el mismo resultado, entre instancias y llamadas; RUC distintos
//    dan razón social distinta.
//  - Centinelas por el último dígito del RUC: termina en 7 -> ErrorTransitorio (se reintenta);
//    termina en 8 -> ErrorDatos (no se reintenta). Cualquier otro final resuelve.
//  - `fallar(modo: "timeout" | "5xx" | "datos" | null, {veces?})`: "timeout" y "5xx" -> ErrorTransitorio,
//    "datos" -> ErrorDatos; sin `veces`, hasta fallar(null); con `veces: n`, las siguientes n llamadas.
//  - `llamadas` (total, incluye fallidas) y `llamadasDe(ruc)`.
//  - Los errores no llevan el RUC ni dato de entrada (message fijo, como en errores.ts).
const RUC_A = "20100070970";
const RUC_B = "20100000001";
const RUC_FALLA_TRANSITORIA = "20100000007";
const RUC_FALLA_DATOS = "20100000008";

describe("MockConsultaRuc", () => {
  it("implementa el puerto ConsultaRuc", async () => {
    const puerto: ConsultaRuc = new MockConsultaRuc();
    const r = await puerto.consultar(RUC_A);
    for (const campo of ["razonSocial", "estado", "condicion"] as const) {
      expect(typeof r[campo]).toBe("string");
      expect(r[campo].length).toBeGreaterThan(0);
    }
  });

  it("la razón social no es la provisional «RUC <ruc>»", async () => {
    const mock = new MockConsultaRuc();
    for (const ruc of [RUC_A, RUC_B, "20100000002"]) {
      expect((await mock.consultar(ruc)).razonSocial).not.toBe(`RUC ${ruc}`);
    }
  });

  it("es determinista por RUC, entre llamadas e instancias", async () => {
    const m1 = new MockConsultaRuc();
    const m2 = new MockConsultaRuc();
    const a = await m1.consultar(RUC_A);
    expect(await m1.consultar(RUC_A)).toEqual(a);
    expect(await m2.consultar(RUC_A)).toEqual(a);
  });

  it("RUC distintos dan razón social distinta", async () => {
    const mock = new MockConsultaRuc();
    const rucs = [RUC_A, RUC_B, "20100000002", "20100000003", "20100000004"];
    const sociales = await Promise.all(
      rucs.map(async (r) => (await mock.consultar(r)).razonSocial),
    );
    expect(new Set(sociales).size).toBe(rucs.length);
  });

  it("cuenta las llamadas, en total y por RUC", async () => {
    const mock = new MockConsultaRuc();
    expect(mock.llamadas).toBe(0);
    await mock.consultar(RUC_A);
    await mock.consultar(RUC_A);
    await mock.consultar(RUC_B);
    expect(mock.llamadas).toBe(3);
    expect(mock.llamadasDe(RUC_A)).toBe(2);
    expect(mock.llamadasDe(RUC_B)).toBe(1);
    expect(mock.llamadasDe("20999999999")).toBe(0);
  });

  describe("centinelas por RUC", () => {
    it("el RUC que termina en 7 falla como transitorio", async () => {
      const mock = new MockConsultaRuc();
      await expect(
        mock.consultar(RUC_FALLA_TRANSITORIA),
      ).rejects.toBeInstanceOf(ErrorTransitorio);
      expect(mock.llamadasDe(RUC_FALLA_TRANSITORIA)).toBe(1);
    });

    it("el RUC que termina en 8 falla como error de datos", async () => {
      const mock = new MockConsultaRuc();
      await expect(mock.consultar(RUC_FALLA_DATOS)).rejects.toBeInstanceOf(
        ErrorDatos,
      );
    });

    it("la centinela no afecta a los demás RUC", async () => {
      const mock = new MockConsultaRuc();
      await expect(
        mock.consultar(RUC_FALLA_TRANSITORIA),
      ).rejects.toBeInstanceOf(ErrorTransitorio);
      await expect(mock.consultar(RUC_A)).resolves.toHaveProperty(
        "razonSocial",
      );
    });
  });

  describe("fallar()", () => {
    it.each([
      ["timeout", ErrorTransitorio],
      ["5xx", ErrorTransitorio],
      ["datos", ErrorDatos],
    ] as const)("%s falla hasta fallar(null)", async (modo, clase) => {
      const mock = new MockConsultaRuc();
      mock.fallar(modo);
      await expect(mock.consultar(RUC_A)).rejects.toBeInstanceOf(clase);
      await expect(mock.consultar(RUC_B)).rejects.toBeInstanceOf(clase);
      mock.fallar(null);
      await expect(mock.consultar(RUC_A)).resolves.toHaveProperty("estado");
    });

    it("con veces: n falla n llamadas y luego funciona", async () => {
      const mock = new MockConsultaRuc();
      mock.fallar("5xx", { veces: 2 });
      await expect(mock.consultar(RUC_A)).rejects.toBeInstanceOf(
        ErrorTransitorio,
      );
      await expect(mock.consultar(RUC_A)).rejects.toBeInstanceOf(
        ErrorTransitorio,
      );
      await expect(mock.consultar(RUC_A)).resolves.toHaveProperty(
        "razonSocial",
      );
      expect(mock.llamadas).toBe(3);
    });
  });

  it("los errores no llevan el RUC ni datos de entrada", async () => {
    const mock = new MockConsultaRuc();
    const errores: unknown[] = [];
    errores.push(
      await mock.consultar(RUC_FALLA_TRANSITORIA).catch((x: unknown) => x),
    );
    errores.push(
      await mock.consultar(RUC_FALLA_DATOS).catch((x: unknown) => x),
    );
    mock.fallar("timeout");
    errores.push(await mock.consultar(RUC_A).catch((x: unknown) => x));
    mock.fallar("datos");
    errores.push(await mock.consultar(RUC_A).catch((x: unknown) => x));
    for (const e of errores) {
      expect(e).toBeInstanceOf(Error);
      const texto = `${String((e as Error).message)} ${String(e)} ${JSON.stringify(e)} ${String((e as Error).stack)}`;
      for (const ruc of [RUC_A, RUC_FALLA_TRANSITORIA, RUC_FALLA_DATOS]) {
        expect(texto).not.toContain(ruc);
      }
    }
  });
});
