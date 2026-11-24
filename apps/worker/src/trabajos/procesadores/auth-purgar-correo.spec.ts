// Spec 028, T5 (rojo): `auth.purgar` suma la purga de correo a los 90 días (R-11, plan, Worker: «`auth-purgar.ts`: suma
// `correo_purgar(90)` junto a `notificacion_purgar`») sin BD: `purgarCorreo(tx, 90)` en el `withTenant` de CADA estudio y su conteo en
// `resultado.correo`; la retención se valida antes de tocar la BD (como las demás). Contrato: `ResultadoAuthPurgar.correo: number` y
// opción `correoDias?: number` (90 por omisión; entero de 1 a 36500).
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  estudios: [] as string[],
  purgarCorreo: vi.fn(async (): Promise<number> => 0),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  purgarAuth: vi.fn(async () => ({ sesiones: 1, tokens: 2, intentos: 3, limites: 4 })),
  estudiosIds: vi.fn(async () => h.estudios),
  purgarTerminados: vi.fn(async () => 0),
  purgarNotificaciones: vi.fn(async () => 0),
  purgarCorreo: h.purgarCorreo,
}));

import { authPurgar, type OpcionesAuthPurgar } from "./auth-purgar.js";

const T1 = "0190a000-0000-7000-8000-0000000000e1";
const T2 = "0190a000-0000-7000-8000-0000000000e2";
type ConCorreo = Awaited<ReturnType<typeof authPurgar>> & { correo: number };
const contextos: unknown[] = [];
const db = {
  withSistema: async (f: (tx: unknown) => unknown) => f({}),
  withTenant: async (c: unknown, f: (tx: unknown) => unknown) => {
    contextos.push(c);
    return f({ id: contextos.length });
  },
} as never;
const opciones = (o: Record<string, unknown> = {}): OpcionesAuthPurgar =>
  ({ db, logger: { info() {}, warn() {}, error() {} }, ...o }) as never;

beforeEach(() => {
  h.estudios = [T1, T2];
  h.purgarCorreo.mockReset();
  h.purgarCorreo.mockResolvedValue(0);
  contextos.length = 0;
});

describe("authPurgar: correo", () => {
  it("purga el correo a 90 días en el estudio de cada transacción y suma los envíos borrados en `correo`", async () => {
    h.purgarCorreo.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
    const r = (await authPurgar(opciones())) as ConCorreo;
    expect(r.correo).toBe(7);
    expect(h.purgarCorreo).toHaveBeenCalledTimes(2);
    expect(h.purgarCorreo).toHaveBeenNthCalledWith(1, expect.anything(), 90);
    expect(h.purgarCorreo).toHaveBeenNthCalledWith(2, expect.anything(), 90);
    expect(contextos).toEqual([{ tenantId: T1 }, { tenantId: T2 }]);
    expect(r).toMatchObject({ sesiones: 1, tokens: 2, intentos: 3, limites: 4 });
  });

  it("respeta `correoDias` y sin estudios no purga nada", async () => {
    await authPurgar(opciones({ correoDias: 45 }));
    expect(h.purgarCorreo).toHaveBeenCalledWith(expect.anything(), 45);
    h.purgarCorreo.mockClear();
    h.estudios = [];
    const r = (await authPurgar(opciones())) as ConCorreo;
    expect(h.purgarCorreo).not.toHaveBeenCalled();
    expect(r.correo).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, 36_501])(
    "una retención de correo inválida (%s) falla con 22023 antes de tocar la BD",
    async (dias) => {
      const err = await authPurgar(opciones({ correoDias: dias })).then(
        () => undefined,
        (x: unknown) => x as { codigo?: string },
      );
      expect(err?.codigo).toBe("22023");
      expect(h.purgarCorreo).not.toHaveBeenCalled();
      expect(contextos).toHaveLength(0);
    },
  );
});
