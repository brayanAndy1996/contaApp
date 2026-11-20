// Selección del puerto `SolPortal` por entorno (spec 023, D-2). `adaptadores.module.spec.ts` no se edita: esto es aparte.
// `SOL_PORTAL` (ausente = `mock`) elige a la vez `SolAuth` y `SolPortal`; `playwright` sigue sin existir y falla al arrancar,
// nombrando la variable y sin imprimir su valor. `SOL_MOCK_LATENCIA_MS` (entero de ms) llega al mock; inválido falla con su nombre.
import { describe, expect, it, vi } from "vitest";
import { MockSolAuth, MockSolPortal } from "@contapp/sunat";
import {
  ConfiguracionAdaptadoresError,
  SOL_PORTAL,
  crearAdaptadores,
  solPortalDesdeEntorno,
} from "./adaptadores.module.js";

const logger = () => ({ warn: vi.fn() });

describe("SolPortal en el módulo de adaptadores (023)", () => {
  it("el token de inyección es «SOL_PORTAL»", () => {
    expect(SOL_PORTAL).toBe("SOL_PORTAL");
  });

  it("entorno vacío: solPortal es MockSolPortal y distinto de solAuth", () => {
    const a = crearAdaptadores({}, logger()) as unknown as {
      solPortal: unknown;
      solAuth: unknown;
    };
    expect(a.solPortal).toBeInstanceOf(MockSolPortal);
    expect(a.solAuth).toBeInstanceOf(MockSolAuth);
    expect(a.solPortal).not.toBe(a.solAuth);
  });

  it("SOL_PORTAL=mock explícito también da el mock", () => {
    expect(solPortalDesdeEntorno({ SOL_PORTAL: "mock" })).toBeInstanceOf(MockSolPortal);
  });

  it("SOL_PORTAL=playwright falla al arrancar, nombra la variable y no imprime el valor", () => {
    for (const fabrica of [
      () => solPortalDesdeEntorno({ SOL_PORTAL: "playwright" }),
      () => crearAdaptadores({ SOL_PORTAL: "playwright" }, logger()),
    ]) {
      let error: unknown;
      try {
        fabrica();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfiguracionAdaptadoresError);
      const e = error as ConfiguracionAdaptadoresError;
      expect(e.variable).toBe("SOL_PORTAL");
      expect(e.message).toContain("SOL_PORTAL");
      expect(e.message).not.toContain("playwright");
    }
  });

  it("SOL_MOCK_LATENCIA_MS válido llega al mock y no altera el resultado", () => {
    expect(solPortalDesdeEntorno({ SOL_MOCK_LATENCIA_MS: "25" })).toBeInstanceOf(MockSolPortal);
    expect(solPortalDesdeEntorno({ SOL_MOCK_LATENCIA_MS: "" })).toBeInstanceOf(MockSolPortal);
  });

  it.each(["rápido", "-5", "1.5", "99999999"])(
    "SOL_MOCK_LATENCIA_MS=%s falla con su nombre y sin el valor",
    (valor) => {
      let error: unknown;
      try {
        solPortalDesdeEntorno({ SOL_MOCK_LATENCIA_MS: valor });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfiguracionAdaptadoresError);
      const e = error as ConfiguracionAdaptadoresError;
      expect(e.variable).toBe("SOL_MOCK_LATENCIA_MS");
      expect(e.message).toContain("SOL_MOCK_LATENCIA_MS");
      expect(e.message).not.toContain(valor);
    },
  );

  it("la guarda de producción sigue nombrando SOL_PORTAL cuando está en mock", () => {
    expect(() => crearAdaptadores({ NODE_ENV: "production" }, logger())).toThrow(/SOL_PORTAL/);
  });
});
