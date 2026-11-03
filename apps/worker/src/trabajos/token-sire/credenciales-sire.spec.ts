// Unitarias de las credenciales SIRE descifradas con el servicio de 003 (T10, D14). BD y servicio dobles.
import { ErrorCredencial } from "@contapp/sunat";
import { describe, expect, it, vi } from "vitest";
import { CredencialNoEncontradaError } from "../../credenciales/errores.js";
import {
  crearCredencialesSire,
  MOTIVO_TOKEN_SIRE,
} from "./credenciales-sire.js";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  estadoCredenciales: vi.fn(async (tx: { filas: unknown[] }) => tx.filas),
}));

const ctx = {
  tenantId: "0190a000-0000-7000-8000-0000000000a1",
  clienteId: "c",
  ruc: "20100070970",
};

function secreto(valor: Record<string, string>) {
  return { usar: (f: (v: unknown) => unknown) => f(valor), destruir: vi.fn() };
}

function montar(
  filas: Array<{ id: string; tipo: string }>,
  descifrar?: (id: string) => Promise<unknown>,
) {
  const sire = secreto({ clientId: "ID", clientSecret: "SEC" });
  const sol = secreto({ usuario: "USR", clave: "CLV" });
  const servicio = {
    descifrarCredencial: vi.fn(
      descifrar ??
        (async (_c: unknown, id: string) => (id === "s1" ? sire : sol)),
    ),
  };
  const db = {
    withTenant: async (_c: unknown, fn: (tx: unknown) => unknown) =>
      fn({ filas }),
  };
  return {
    f: crearCredencialesSire({ db: db as never, servicio: servicio as never }),
    servicio,
    sire,
    sol,
  };
}

describe("crearCredencialesSire", () => {
  it("caso feliz: arma la credencial con sire_api y sol, y destruye los secretos", async () => {
    const m = montar([
      { id: "s1", tipo: "sire_api" },
      { id: "s2", tipo: "sol" },
    ]);
    expect(await m.f(ctx)).toEqual({
      clientId: "ID",
      clientSecret: "SEC",
      usuarioSol: "USR",
      claveSol: "CLV",
      ruc: ctx.ruc,
    });
    expect(m.servicio.descifrarCredencial).toHaveBeenCalledWith(
      { tenantId: ctx.tenantId },
      "s1",
      MOTIVO_TOKEN_SIRE,
    );
    expect(m.sire.destruir).toHaveBeenCalled();
    expect(m.sol.destruir).toHaveBeenCalled();
  });

  it("error: sin alguna de las dos credenciales, o borrada antes de descifrar, ErrorCredencial", async () => {
    await expect(
      montar([{ id: "s1", tipo: "sire_api" }]).f(ctx),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    const borrada = montar(
      [
        { id: "s1", tipo: "sire_api" },
        { id: "s2", tipo: "sol" },
      ],
      async () => {
        throw new CredencialNoEncontradaError();
      },
    );
    await expect(borrada.f(ctx)).rejects.toBeInstanceOf(ErrorCredencial);
  });

  it("otros errores del descifrado se propagan tal cual", async () => {
    const e = new Error("llave");
    const m = montar(
      [
        { id: "s1", tipo: "sire_api" },
        { id: "s2", tipo: "sol" },
      ],
      async () => {
        throw e;
      },
    );
    await expect(m.f(ctx)).rejects.toBe(e);
  });
});
