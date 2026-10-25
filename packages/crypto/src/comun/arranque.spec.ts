import { afterEach, describe, expect, it, vi } from "vitest";
import { arrancarSiDirecta, esEjecucionDirecta } from "./arranque";

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

describe("arrancarSiDirecta", () => {
  const codigoOriginal = process.exitCode;
  afterEach(() => {
    process.exitCode = codigoOriginal;
  });

  it("en ejecución directa corre el ejecutor con argv y fija process.exitCode", async () => {
    const modulo = { id: "cli" };
    const ejecutor = vi.fn(async () => 7);
    arrancarSiDirecta(modulo, modulo, ejecutor, ["--salida", "x"]);
    expect(ejecutor).toHaveBeenCalledWith(["--salida", "x"]);
    await vi.waitFor(() => expect(process.exitCode).toBe(7));
  });

  it("si el módulo fue importado no corre nada ni toca process.exitCode", () => {
    process.exitCode = undefined;
    const ejecutor = vi.fn(async () => 1);
    arrancarSiDirecta(undefined, { id: "cli" }, ejecutor, []);
    expect(ejecutor).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
