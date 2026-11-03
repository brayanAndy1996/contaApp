// Unitarias de logs y avisos (T10, CA-16).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  camposTrabajo,
  loggerConsola,
  NotificadorLog,
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

  it("NotificadorLog registra el aviso solo con ids (por defecto en consola)", async () => {
    const warn = vi.fn();
    await new NotificadorLog({
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }).credencialInvalida({
      tenantId: "t",
      clienteId: "c",
      tipo: "sol",
      trabajoId: "j",
    });
    expect(warn).toHaveBeenCalledWith({
      evento: "aviso_credencial_invalida",
      cliente_id: "c",
      credencial: "sol",
      trabajo_id: "j",
    });
    const consola = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    await new NotificadorLog().credencialInvalida({
      tenantId: "t",
      clienteId: "c",
      tipo: "sire_api",
      trabajoId: "j",
    });
    expect(consola).toHaveBeenCalledTimes(1);
  });
});
