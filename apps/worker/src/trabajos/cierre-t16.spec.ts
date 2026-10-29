// T16 (backend, H-008-2a-5) · El cierre del pool de la BD tiene tope: con la BD sin responder, `pool.end()` no termina
// nunca y el proceso no salía tras SIGTERM. La vía real (worker compilado, red partida) la fija `cierre-r2a`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cerrarConTope, ESPERA_CIERRE_BD_MS } from "./trabajos.module.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("cerrarConTope", () => {
  it("termina en cuanto termina el cierre", async () => {
    let listo = false;
    const p = cerrarConTope(Promise.resolve(), ESPERA_CIERRE_BD_MS).then(() => (listo = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(listo).toBe(true);
    await p;
  });

  it("error: un cierre que no termina (o que falla) no retiene más que el tope ni lanza", async () => {
    let listo = false;
    const p = cerrarConTope(new Promise(() => undefined), ESPERA_CIERRE_BD_MS).then(() => (listo = true));
    await vi.advanceTimersByTimeAsync(ESPERA_CIERRE_BD_MS - 1);
    expect(listo).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(listo).toBe(true);
    await p;
    await expect(cerrarConTope(Promise.reject(new Error("bd")), 10)).resolves.toBeUndefined();
  });
});
