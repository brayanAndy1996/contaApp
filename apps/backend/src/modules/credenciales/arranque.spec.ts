// Spec 009 (T6, CA-7) · `keyWrapperDelBackend`: fuera de development y test el KeyWrapper se crea al arrancar.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/crypto", async (original) => ({
  ...(await original<typeof import("@contapp/crypto")>()),
  crearKeyWrapper: vi.fn(),
}));

import { crearKeyWrapper } from "@contapp/crypto";
import { keyWrapperDelBackend } from "./key-wrapper.js";

beforeEach(() => vi.resetAllMocks());

describe("keyWrapperDelBackend (CA-7)", () => {
  it("en producción lo crea al instanciar y lo memoiza", () => {
    const wrapper = {};
    vi.mocked(crearKeyWrapper).mockReturnValue(wrapper as never);
    const obtener = keyWrapperDelBackend({ NODE_ENV: "production", KEY_PROVIDER: "local" });
    expect(crearKeyWrapper).toHaveBeenCalledTimes(1);
    expect(obtener()).toBe(wrapper);
    expect(crearKeyWrapper).toHaveBeenCalledTimes(1);
  });

  it("sin NODE_ENV también falla cerrado: se crea al arrancar", () => {
    vi.mocked(crearKeyWrapper).mockReturnValue({} as never);
    keyWrapperDelBackend({ KEY_PROVIDER: "local" });
    expect(crearKeyWrapper).toHaveBeenCalledTimes(1);
  });

  it("en producción con la ruta privada presente el arranque falla y el error no trae valores", () => {
    vi.mocked(crearKeyWrapper).mockImplementation(() => {
      throw new Error("el backend no puede tener la llave privada");
    });
    const secreto = "/ruta/secreta/privada.pem";
    let error: unknown;
    try {
      keyWrapperDelBackend({ NODE_ENV: "production", KEK_PRIVATE_KEY_PATH: secreto });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(secreto);
  });

  it.each(["development", "test"])("en %s sigue perezoso: no crea nada hasta el primer uso", (NODE_ENV) => {
    vi.mocked(crearKeyWrapper).mockReturnValue({} as never);
    const obtener = keyWrapperDelBackend({ NODE_ENV, KEY_PROVIDER: "mock" });
    expect(crearKeyWrapper).not.toHaveBeenCalled();
    obtener();
    expect(crearKeyWrapper).toHaveBeenCalledTimes(1);
  });

  it("en development un entorno inválido no rompe el arranque (falla en el primer uso)", () => {
    vi.mocked(crearKeyWrapper).mockImplementation(() => {
      throw new Error("sin proveedor");
    });
    const obtener = keyWrapperDelBackend({ NODE_ENV: "development" });
    expect(obtener).toThrow("sin proveedor");
  });
});
