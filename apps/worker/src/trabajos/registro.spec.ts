// Unitarias de logs (T10, CA-16). Spec 017 · T4: el test de `NotificadorLog` se fue con la clase; lo que lo reemplaza
// (`NotificadorEventos`, el puerto `avisar`) está en notificador.spec.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  camposTrabajo,
  loggerConsola,
  registrar,
} from "./registro.js";

afterEach(() => vi.restoreAllMocks());

describe("registro", () => {
  it("loggerConsola escribe una línea JSON por nivel", () => {
    const espias = (["debug", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    for (const m of ["debug", "info", "warn", "error"] as const)
      registrar(loggerConsola, m, { evento: `e_${m}` });
    espias.forEach((s, i) =>
      expect(s).toHaveBeenCalledWith(
        JSON.stringify({
          evento: `e_${["debug", "info", "warn", "error"][i]}`,
        }),
      ),
    );
  });

  it("un logger que falla o que no tiene el nivel no rompe el flujo", () => {
    const roto = {
      info: () => {
        throw new Error("x");
      },
      warn: vi.fn(),
      error: vi.fn(),
    };
    expect(() => registrar(roto, "info", { evento: "a" })).not.toThrow();
    expect(() => registrar(roto, "debug", { evento: "b" })).not.toThrow();
  });

  it("camposTrabajo lleva siempre los tres campos", () => {
    expect(camposTrabajo({ tenantId: "t", id: "j", tipo: "a.b" })).toEqual({
      tenant_id: "t",
      job_id: "j",
      tipo: "a.b",
    });
  });
});
