import { beforeEach, describe, expect, it, vi } from "vitest";

// Cableado del punto de entrada: al cargarse, el CLI delega en ejecutarSiDirecta con "seed" y su
// `main`. Se simula el arranque y se recarga el CLI (sin caché de módulos, por si otra suite del
// mismo worker ya lo cargó) para no conectarse a ninguna base.
vi.mock("./comun", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ejecutarSiDirecta: vi.fn(),
}));

describe("db:seed · arranque", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("delega en ejecutarSiDirecta con 'seed' y main", async () => {
    const { ejecutarSiDirecta } = await import("./comun.js");
    const { main } = await import("./seed.js");
    expect(ejecutarSiDirecta).toHaveBeenCalledTimes(1);
    const [, , nombre, fn] = vi.mocked(ejecutarSiDirecta).mock.calls[0]!;
    expect(nombre).toBe("seed");
    expect(fn).toBe(main);
  });
});
