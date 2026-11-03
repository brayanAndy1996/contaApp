import { beforeEach, describe, expect, it, vi } from "vitest";

// T15a · cableado del punto de entrada (igual que seed-arranque): al cargarse, el CLI delega en
// ejecutarSiDirecta con "plataforma-alta" y su `main`, sin conectarse a ninguna base.
vi.mock("./comun", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ejecutarSiDirecta: vi.fn(),
}));

describe("db:plataforma-alta · arranque", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("delega en ejecutarSiDirecta con 'plataforma-alta' y main", async () => {
    const { ejecutarSiDirecta } = await import("./comun.js");
    const { main } = await import("./plataforma-alta.js");
    expect(ejecutarSiDirecta).toHaveBeenCalledTimes(1);
    const [, , nombre, fn] = vi.mocked(ejecutarSiDirecta).mock.calls[0]!;
    expect(nombre).toBe("plataforma-alta");
    expect(fn).toBe(main);
  });
});
