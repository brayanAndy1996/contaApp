// Spec 007b (T12, cobertura de T10) · `keyWrapperPerezoso`: perezoso, memoizado y con el entorno acotado fuera de producción.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/crypto", async (original) => ({
  ...(await original<typeof import("@contapp/crypto")>()),
  crearKeyWrapper: vi.fn(),
}));

import { crearKeyWrapper } from "@contapp/crypto";
import { keyWrapperPerezoso } from "./key-wrapper.js";

beforeEach(() => vi.resetAllMocks());

describe("keyWrapperPerezoso", () => {
  it("no crea nada hasta el primer uso y memoiza el resultado", () => {
    const wrapper = { envolver: vi.fn() };
    vi.mocked(crearKeyWrapper).mockReturnValue(wrapper as never);
    const obtener = keyWrapperPerezoso({ KEY_PROVIDER: "mock" });
    expect(crearKeyWrapper).not.toHaveBeenCalled();
    expect(obtener()).toBe(wrapper);
    expect(obtener()).toBe(wrapper);
    expect(crearKeyWrapper).toHaveBeenCalledTimes(1);
  });

  it("fuera de producción solo entrega las variables de cifrado (nunca KEK_PRIVATE_KEY_PATH)", () => {
    vi.mocked(crearKeyWrapper).mockReturnValue({} as never);
    keyWrapperPerezoso({ KEY_PROVIDER: "mock", KEK_ID: "k1", KEK_PRIVATE_KEY_PATH: "/privada", OTRA: "x", NODE_ENV: "test" })();
    expect(vi.mocked(crearKeyWrapper).mock.calls[0]?.[0]).toEqual({
      KEY_PROVIDER: "mock",
      KEK_ID: "k1",
      KEK_PUBLIC_KEY_PATH: undefined,
      NODE_ENV: "test",
    });
  });

  it("en producción pasa el entorno entero, para que el proveedor se niegue si trae la llave privada", () => {
    vi.mocked(crearKeyWrapper).mockReturnValue({} as never);
    const env = { NODE_ENV: " Production ", KEK_PRIVATE_KEY_PATH: "/privada" };
    keyWrapperPerezoso(env)();
    expect(vi.mocked(crearKeyWrapper).mock.calls[0]?.[0]).toBe(env);
  });

  it("un entorno mal configurado falla en el primer uso, no al crear la función", () => {
    vi.mocked(crearKeyWrapper).mockImplementation(() => {
      throw new Error("sin proveedor");
    });
    const obtener = keyWrapperPerezoso({});
    expect(obtener).toThrow("sin proveedor");
  });
});
