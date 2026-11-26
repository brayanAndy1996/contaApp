// Spec 027, T5 (rojo) · Unitarias de `asegurarCiiu` que cubren las ramas que las de integración no alcanzan: lista vacía y BD caída.
// Sin BD, Redis ni red: `withTenant` doble.
//
// CONTRATO que fija (T11): `asegurarCiiu` NUNCA lanza (un CIIU que falta no puede fallar el trabajo del XML, R-14), aunque la BD
// caiga al leer los pendientes o al guardar.
import { ErrorDatos, ErrorTransitorio } from "@contapp/sunat";
import { describe, expect, it, vi } from "vitest";
import { asegurarCiiu } from "./ciiu.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUC = "20700000070";

describe("asegurarCiiu: nunca lanza", () => {
  it("sin RUC que pedir resuelve sin consultar", async () => {
    const consultar = vi.fn();
    const withTenant = vi.fn().mockResolvedValue([]);
    await expect(
      asegurarCiiu({ db: { withTenant } as never, consultaRuc: { consultar } }, { tenantId: TENANT }, []),
    ).resolves.toBeUndefined();
    expect(consultar).not.toHaveBeenCalled();
  });

  it("la BD cae al leer los pendientes: resuelve sin lanzar y el error no llega a la consulta", async () => {
    const consultar = vi.fn().mockRejectedValue(new ErrorTransitorio());
    const withTenant = vi.fn().mockRejectedValue(new Error("conexión perdida"));
    await expect(
      asegurarCiiu({ db: { withTenant } as never, consultaRuc: { consultar } }, { tenantId: TENANT }, [RUC]),
    ).resolves.toBeUndefined();
    expect(withTenant.mock.calls[0]![0]).toMatchObject({ tenantId: TENANT });
  });

  it.each([
    ["ErrorDatos", new ErrorDatos()],
    ["ErrorTransitorio", new ErrorTransitorio()],
    ["un error cualquiera", new Error("boom")],
  ])("la BD cae y el puerto responde %s: resuelve sin lanzar", async (_nombre, error) => {
    const consultar = vi.fn().mockRejectedValue(error);
    const withTenant = vi.fn().mockRejectedValue(new Error("conexión perdida"));
    await expect(
      asegurarCiiu({ db: { withTenant } as never, consultaRuc: { consultar } }, { tenantId: TENANT }, [RUC]),
    ).resolves.toBeUndefined();
  });
});
