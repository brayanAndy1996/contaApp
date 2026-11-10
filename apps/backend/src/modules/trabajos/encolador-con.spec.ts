// Spec 016, T17a · `Encolador.encolarCon` (T13): `antes(tx)` corre en la MISMA transacción que `encolar` y antes de ella; si
// `antes` lanza o `encolar` rechaza, la transacción se revierte y no se publica nada; la pista y el evento salen solo tras el
// commit. Sin BD ni Redis: `withTenant` en memoria que registra si la transacción se confirmó o se revirtió.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/queue", async (original) => ({
  ...(await original<typeof import("@contapp/queue")>()),
  encolar: vi.fn(),
}));

import {
  ColaLlenaError,
  ParametrosInvalidosError,
  encolar,
  type EntradaEncolar,
} from "@contapp/queue";
import type { TrabajoVista } from "@contapp/shared";
import { Encolador } from "./encolador.js";
import type { RedisTrabajos } from "./redis.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const TX = { tx: true };
const entrada: EntradaEncolar = {
  tipo: "xml.obtener",
  clienteId: "33333333-3333-4333-8333-333333333333",
  parametros: { periodo: "202610", compraIds: ["0190a000-0000-4000-8000-000000000001"] },
  prioridad: "interactivo",
  creadoPor: USUARIO,
};
const trabajo: TrabajoVista = {
  id: "55555555-5555-4555-8555-555555555555",
  tipo: "xml.obtener",
  clienteId: entrada.clienteId,
  estado: "en_cola",
  posicion: null,
  intentos: 0,
  motivo: null,
  creadoEn: new Date(0).toISOString(),
  iniciadoEn: null,
  terminadoEn: null,
  creadoPor: null,
};

/** Registro ordenado de lo que pasa: lo que corre en la transacción, su desenlace y lo que se publica. */
let bitacora: string[];

function armar(publicador: unknown = "conexion") {
  const conexion = {
    zadd: vi.fn(async () => {
      bitacora.push("publica-pista");
      return 1;
    }),
    sadd: vi.fn(async () => 1),
    publish: vi.fn(async () => {
      bitacora.push("publica-evento");
      return 1;
    }),
  };
  const withTenant = vi.fn(
    async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      bitacora.push("abre");
      try {
        const r = await fn(TX);
        bitacora.push("commit");
        return r;
      } catch (e) {
        bitacora.push("rollback");
        throw e;
      }
    },
  );
  const redis = {
    prefijo: "p:",
    publicador: () => (publicador === "conexion" ? conexion : publicador),
  } as unknown as RedisTrabajos;
  return { conexion, withTenant, enc: new Encolador({ withTenant } as never, redis) };
}

beforeEach(() => {
  vi.resetAllMocks();
  bitacora = [];
  vi.mocked(encolar).mockImplementation((async () => {
    bitacora.push("encola");
    return { trabajo, nuevo: true };
  }) as never);
});

describe("Encolador.encolarCon", () => {
  it("corre antes(tx) y luego encolar en la misma transacción; publica solo después del commit", async () => {
    const { enc, withTenant } = armar();
    const antes = vi.fn(async (tx: unknown) => {
      expect(tx).toBe(TX);
      bitacora.push("antes");
    });
    const r = await enc.encolarCon({ tenantId: TENANT, userId: USUARIO }, entrada, antes as never);
    expect(r).toEqual({ trabajo, nuevo: true });
    expect(bitacora).toEqual([
      "abre",
      "antes",
      "encola",
      "commit",
      expect.stringMatching(/^publica-/),
      expect.stringMatching(/^publica-/),
    ]);
    expect(bitacora.slice(-2).sort()).toEqual(["publica-evento", "publica-pista"]);
    // Una sola transacción, la del estudio y usuario del contexto, y encolar recibe esa misma tx y la entrada.
    expect(withTenant).toHaveBeenCalledTimes(1);
    expect(withTenant.mock.calls[0]?.[0]).toEqual({ tenantId: TENANT, userId: USUARIO });
    expect(encolar).toHaveBeenCalledWith(TX, entrada);
  });

  it("si antes lanza: se revierte, el error sale sin envolver, no se encola y no se publica nada", async () => {
    const { enc, conexion } = armar();
    const fallo = new Error("el comprobante no admite XML");
    const error = await enc
      .encolarCon({ tenantId: TENANT }, entrada, async () => {
        bitacora.push("antes");
        throw fallo;
      })
      .catch((e: unknown) => e);
    expect(error).toBe(fallo);
    expect(encolar).not.toHaveBeenCalled();
    expect(bitacora).toEqual(["abre", "antes", "rollback"]);
    expect(conexion.zadd).not.toHaveBeenCalled();
    expect(conexion.publish).not.toHaveBeenCalled();
  });

  it("si encolar rechaza (cola llena): lo que escribió antes se revierte con ella, el error sale tipado y no se publica nada", async () => {
    vi.mocked(encolar).mockImplementation((async () => {
      bitacora.push("encola");
      throw new ColaLlenaError();
    }) as never);
    const { enc, conexion } = armar();
    const error = await enc
      .encolarCon({ tenantId: TENANT }, entrada, async () => {
        bitacora.push("antes");
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ColaLlenaError);
    expect(bitacora).toEqual(["abre", "antes", "encola", "rollback"]);
    expect(conexion.zadd).not.toHaveBeenCalled();
    expect(conexion.publish).not.toHaveBeenCalled();
  });

  it("si encolar rechaza los parámetros: igual, se revierte y el error es el de parámetros", async () => {
    vi.mocked(encolar).mockRejectedValue(new ParametrosInvalidosError());
    const { enc, conexion } = armar();
    await expect(
      enc.encolarCon({ tenantId: TENANT }, entrada, async () => undefined),
    ).rejects.toBeInstanceOf(ParametrosInvalidosError);
    expect(bitacora).toEqual(["abre", "rollback"]);
    expect(conexion.publish).not.toHaveBeenCalled();
  });

  it("con dedupe (nuevo: false) el trabajo existente se devuelve y no se publica", async () => {
    vi.mocked(encolar).mockResolvedValue({ trabajo, nuevo: false } as never);
    const { enc, conexion } = armar();
    const antes = vi.fn(async () => undefined);
    await expect(enc.encolarCon({ tenantId: TENANT }, entrada, antes)).resolves.toEqual({
      trabajo,
      nuevo: false,
    });
    expect(antes).toHaveBeenCalledTimes(1);
    expect(conexion.zadd).not.toHaveBeenCalled();
    expect(conexion.publish).not.toHaveBeenCalled();
  });

  it("con la app cerrando (sin conexión de publicación) devuelve el trabajo sin publicar", async () => {
    const { enc } = armar(null);
    await expect(
      enc.encolarCon({ tenantId: TENANT }, entrada, async () => undefined),
    ).resolves.toEqual({ trabajo, nuevo: true });
    expect(bitacora).toEqual(["abre", "encola", "commit"]);
  });
});
