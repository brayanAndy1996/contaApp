import { afterEach, describe, expect, it, vi } from "vitest";
import { ejecutarSiDirecta, esEjecucionDirecta } from "./comun";

describe("esEjecucionDirecta", () => {
  it("es verdadera cuando el módulo principal es el propio módulo", () => {
    const modulo = { id: "cli" };
    expect(esEjecucionDirecta(modulo, modulo)).toBe(true);
  });

  it("es falsa cuando el módulo fue importado por otro (o no hay principal)", () => {
    expect(esEjecucionDirecta({ id: "otro" }, { id: "cli" })).toBe(false);
    expect(esEjecucionDirecta(undefined, { id: "cli" })).toBe(false);
  });
});

describe("ejecutarSiDirecta", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("en ejecución directa corre fn e imprime '<nombre>: OK'", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const modulo = { id: "cli" };
    const fn = vi.fn(async () => {});
    ejecutarSiDirecta(modulo, modulo, "seed", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("seed: OK"));
  });

  it("si el módulo fue importado no corre fn ni imprime nada", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fn = vi.fn(async () => {});
    ejecutarSiDirecta(undefined, { id: "cli" }, "seed", fn);
    expect(fn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
