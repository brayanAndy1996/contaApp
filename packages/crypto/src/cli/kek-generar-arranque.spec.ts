import { beforeEach, describe, expect, it, vi } from "vitest";

// Cableado del punto de entrada: al cargarse, el CLI delega en arrancarSiDirecta con su `ejecutar`
// y los argumentos del proceso. Se simula el arranque y se recarga el CLI (sin caché de módulos,
// por si otra suite del mismo worker ya lo cargó) para no ejecutar nada real.
vi.mock("../comun/arranque", () => ({ arrancarSiDirecta: vi.fn() }));

describe("kek:generar · arranque", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("delega en arrancarSiDirecta con ejecutar y process.argv.slice(2)", async () => {
    const { arrancarSiDirecta } = await import("../comun/arranque.js");
    const { ejecutar } = await import("./kek-generar.js");
    expect(arrancarSiDirecta).toHaveBeenCalledTimes(1);
    const [, , ejecutor, argv] = vi.mocked(arrancarSiDirecta).mock.calls[0]!;
    expect(ejecutor).toBe(ejecutar);
    expect(argv).toEqual(process.argv.slice(2));
  });
});
