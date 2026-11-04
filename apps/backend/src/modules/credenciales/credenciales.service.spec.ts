// Spec 007b (T12, cobertura de T10) · `CredencialesService` sin BD: cliente inexistente y fallo de cifrado.
// El cifrado con AAD, el estado y la verificación completos los cubre `credenciales.int.spec.ts`.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerClienteDto: vi.fn(),
  leerEstadoCredenciales: vi.fn(),
  guardarSobre: vi.fn(),
}));

import { MockKeyProvider } from "@contapp/crypto";
import { guardarSobre, leerClienteDto, leerEstadoCredenciales } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { CredencialesService } from "./credenciales.service.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const ACTOR = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const sesion = { tenantActivo: TENANT, usuarioId: ACTOR } as SesionResuelta;
const SECRETO = "CANARIO-clave-que-no-debe-salir";
const encolador = { encolar: vi.fn() };
const wrapper = vi.fn();

function armar() {
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ tx: true })));
  return new CredencialesService({ withTenant } as never, wrapper as never, encolador as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(leerClienteDto).mockResolvedValue(null);
});

describe("cliente inexistente en el estudio", () => {
  it("estado y verificar responden no_encontrado y no leen credenciales ni encolan nada", async () => {
    await expect(armar().estado(sesion, CLIENTE)).rejects.toMatchObject({ codigo: "no_encontrado" });
    await expect(armar().verificar(sesion, CLIENTE, "sol")).rejects.toMatchObject({ codigo: "no_encontrado" });
    expect(leerEstadoCredenciales).not.toHaveBeenCalled();
    expect(encolador.encolar).not.toHaveBeenCalled();
  });

  it("guardar (cifra con el proveedor mock) responde no_encontrado y no escribe el sobre", async () => {
    wrapper.mockReturnValue(new MockKeyProvider());
    await expect(armar().guardar(sesion, CLIENTE, "sol", { usuario: "u", clave: SECRETO })).rejects.toMatchObject({ codigo: "no_encontrado" });
    expect(guardarSobre).not.toHaveBeenCalled();
  });
});

describe("fallos de cifrado", () => {
  it("se reducen a 500 {codigo: error_interno} sin causa ni rastro del secreto", async () => {
    wrapper.mockImplementation(() => {
      throw new Error(`falla con ${SECRETO}`);
    });
    const e = await armar()
      .guardar(sesion, CLIENTE, "sire_api", { clientId: "id", clientSecret: SECRETO })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 500, response: { codigo: "error_interno" } });
    expect(JSON.stringify(e)).not.toContain(SECRETO);
    expect((e as Error).cause).toBeUndefined();
    expect((e as Error).message).not.toContain(SECRETO);
  });
});
