// Unitarias del módulo Nest de trabajos (T10): configuración desde el entorno y ciclo de vida (arranque y cierre
// ordenado). BD, Redis, llaves e `iniciarTrabajos` son dobles.
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  iniciar: vi.fn(),
  detener: vi.fn(async () => undefined),
  cerrarDb: vi.fn(async () => undefined),
  desconectar: vi.fn(),
  anterior: vi.fn((a: unknown) => a),
}));
vi.mock("./iniciar.js", () => ({
  iniciarTrabajos: async (d: unknown) => {
    h.iniciar(d);
    return { detener: h.detener, abortar: vi.fn() };
  },
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  createDb: () => ({ close: h.cerrarDb }),
}));
vi.mock("ioredis", () => ({
  Redis: class {
    disconnect = h.desconectar;
  },
}));
vi.mock("@contapp/crypto/descifrado", () => ({
  crearKeyUnwrapper: () => ({ kekId: "k2" }),
  crearKeyUnwrapperAnterior: h.anterior,
}));

import { MockSireAuth } from "@contapp/sunat";
import {
  ConfiguracionTrabajosError,
  llavesDesdeEntorno,
  sireAuthDesdeEntorno,
  TrabajosModule,
  TrabajosService,
} from "./trabajos.module.js";

describe("TrabajosModule", () => {
  it("SIRE_CLIENT=mock (o ausente) usa MockSireAuth; otro valor falla al arrancar", () => {
    expect(sireAuthDesdeEntorno({})).toBeInstanceOf(MockSireAuth);
    expect(sireAuthDesdeEntorno({ SIRE_CLIENT: "mock" })).toBeInstanceOf(
      MockSireAuth,
    );
    expect(() => sireAuthDesdeEntorno({ SIRE_CLIENT: "real" })).toThrow(
      ConfiguracionTrabajosError,
    );
  });

  it("la KEK anterior se busca junto a la activa como <desde>.pem", () => {
    const llaves = llavesDesdeEntorno({
      KEK_PRIVATE_KEY_PATH: "/llaves/kek-private.pem",
    });
    expect(llaves.activa).toEqual({ kekId: "k2" });
    llaves.anterior("k1");
    expect(h.anterior).toHaveBeenCalledWith({
      kekId: "k1",
      rutaPrivada: "/llaves/k1.pem",
    });
    llavesDesdeEntorno({}).anterior("k0");
    expect(h.anterior).toHaveBeenLastCalledWith({
      kekId: "k0",
      rutaPrivada: "k0.pem",
    });
  });

  it("arranca con la BD del worker, Redis y la conexión de REDIS_URL, y al cerrar espera y libera", async () => {
    const antes = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://localhost:6379/3";
    try {
      const s = new TrabajosService();
      await s.onApplicationBootstrap();
      expect(h.iniciar).toHaveBeenCalledWith(
        expect.objectContaining({
          conexionBull: { host: "localhost", port: 6379, db: 3 },
        }),
      );
      await s.onApplicationShutdown();
      expect(h.detener).toHaveBeenCalledWith({ esperaMs: 30_000 });
      expect(h.desconectar).toHaveBeenCalled();
      expect(h.cerrarDb).toHaveBeenCalled();
      expect(new TrabajosModule()).toBeInstanceOf(TrabajosModule);
    } finally {
      if (antes === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = antes;
    }
  });

  it("error: sin REDIS_URL válida no arranca; cerrar sin haber arrancado no falla", async () => {
    const antes = process.env.REDIS_URL;
    process.env.REDIS_URL = "no-es-url";
    try {
      const s = new TrabajosService();
      await expect(s.onApplicationBootstrap()).rejects.toThrow(
        "REDIS_URL ausente o inválida",
      );
      await expect(s.onApplicationShutdown()).resolves.toBeUndefined();
    } finally {
      if (antes === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = antes;
    }
  });
});
