// Spec 027, T5 (rojo) · Unitarias de `compras.reevaluar` que cubren las ramas que las de integración no alcanzan: parámetros
// inválidos (no tocan la BD) y fallo de BD (sube tal cual para que el ejecutor decida). Sin BD, Redis ni red: `withTenant` doble.
//
// CONTRATO que fija (T11): `reevaluarPeriodo({ db })` valida `{ periodo: AAAAMM }` (`.strict()`) con `ErrorDatos` fijo (sin repetir
// lo recibido) ANTES de abrir ninguna transacción; un fallo de BD no se traga: el procesador lo propaga.
import { ErrorDatos } from "@contapp/sunat";
import { describe, expect, it, vi } from "vitest";
import { reevaluarPeriodo } from "./reevaluar-periodo.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CLIENTE = "33333333-3333-4333-8333-333333333333";
const TRABAJO = "0190a000-0000-4000-8000-000000000001";

function ctx(parametros: unknown) {
  return {
    trabajo: {
      id: TRABAJO,
      tenantId: TENANT,
      clienteId: CLIENTE,
      ruc: "20700000002",
      tipo: "compras.reevaluar",
      parametros,
      intentos: 0,
      creadoPor: null,
    },
    conToken: () => {
      throw new Error("compras.reevaluar no usa credenciales ni token");
    },
  };
}

const CANARIO = "CANARIO-parametro-7f3a";

describe("compras.reevaluar: parámetros", () => {
  it.each([
    ["sin periodo", {}],
    ["periodo con guion", { periodo: "2026-10" }],
    ["periodo corto", { periodo: "20261" }],
    ["periodo no numérico", { periodo: "abcdef" }],
    ["periodo numérico (no texto)", { periodo: 202610 }],
    ["clave de más", { periodo: "202610", extra: 1 }],
    ["canario como periodo", { periodo: CANARIO }],
    ["nulo", null],
  ])("%s: ErrorDatos fijo, sin abrir transacciones y sin repetir lo recibido", async (_nombre, parametros) => {
    const withTenant = vi.fn();
    const proc = reevaluarPeriodo({ db: { withTenant } as never });
    const error = await proc(ctx(parametros)).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(ErrorDatos);
    expect(`${error!.message}\n${error!.stack ?? ""}\n${JSON.stringify(error)}`).not.toContain(CANARIO);
    expect(withTenant).not.toHaveBeenCalled();
  });
});

describe("compras.reevaluar: fallo de BD", () => {
  it("lo propaga (no devuelve un resultado a medias) y abre la transacción en el estudio del trabajo", async () => {
    const fallo = new Error("conexión perdida");
    const withTenant = vi.fn().mockRejectedValue(fallo);
    const proc = reevaluarPeriodo({ db: { withTenant } as never });

    await expect(proc(ctx({ periodo: "202610" }))).rejects.toBe(fallo);
    expect(withTenant).toHaveBeenCalled();
    expect(withTenant.mock.calls[0]![0]).toMatchObject({ tenantId: TENANT });
  });
});
