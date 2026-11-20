// Spec 023, T15 (cobertura): credencial SOL del trabajo del buzón. Ramas que la integración no recorre: sin credencial,
// credencial borrada entre la lectura y el descifrado, otros errores y destrucción del secreto.
import { ErrorCredencial } from "@contapp/sunat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  filas: [] as { id: string; tipo: string }[],
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  estadoCredenciales: vi.fn(async () => h.filas),
}));

import { CredencialNoEncontradaError } from "../../credenciales/errores.js";
import {
  descifrarCredencialSol,
  ubicarCredencialSol,
} from "./credencial-sol.js";

const trabajo = {
  tenantId: "t-1",
  ruc: "20700000002",
  tipo: "sol.buzon.revisar",
};

function secretoFalso(valor: unknown) {
  const destruir = vi.fn();
  return {
    destruir,
    usar: <T>(f: (v: unknown) => T): T => f(valor),
  };
}

beforeEach(() => {
  h.filas = [];
});

describe("ubicarCredencialSol", () => {
  it("devuelve el id de la credencial `sol` entre las del cliente", async () => {
    h.filas = [
      { id: "c-sire", tipo: "sire_api" },
      { id: "c-sol", tipo: "sol" },
    ];
    expect(await ubicarCredencialSol({} as never, "cli-1")).toBe("c-sol");
  });

  it("sin credencial `sol` devuelve null", async () => {
    h.filas = [{ id: "c-sire", tipo: "sire_api" }];
    expect(await ubicarCredencialSol({} as never, "cli-1")).toBeNull();
    h.filas = [];
    expect(await ubicarCredencialSol({} as never, "cli-1")).toBeNull();
  });
});

describe("descifrarCredencialSol", () => {
  it("sin id: ErrorCredencial y no toca el servicio", async () => {
    const servicio = { descifrarCredencial: vi.fn() };
    await expect(
      descifrarCredencialSol({ db: {} as never, servicio }, trabajo, null),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    expect(servicio.descifrarCredencial).not.toHaveBeenCalled();
  });

  it("arma la credencial del puerto con el RUC del trabajo, usa el tipo como motivo y destruye el secreto", async () => {
    const secreto = secretoFalso({ usuario: "USUARIO", clave: "CLAVE" });
    const servicio = { descifrarCredencial: vi.fn(async () => secreto) };
    const r = await descifrarCredencialSol(
      { db: {} as never, servicio: servicio as never },
      trabajo,
      "c-1",
    );
    expect(r).toEqual({
      ruc: "20700000002",
      usuarioSol: "USUARIO",
      claveSol: "CLAVE",
    });
    expect(servicio.descifrarCredencial).toHaveBeenCalledWith(
      { tenantId: "t-1" },
      "c-1",
      "sol.buzon.revisar",
    );
    expect(secreto.destruir).toHaveBeenCalledTimes(1);
  });

  it("credencial borrada entre la lectura y el descifrado: ErrorCredencial, igual que si no existiera", async () => {
    const servicio = {
      descifrarCredencial: vi.fn(async () => {
        throw new CredencialNoEncontradaError();
      }),
    };
    const e = await descifrarCredencialSol(
      { db: {} as never, servicio: servicio as never },
      trabajo,
      "c-1",
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorCredencial);
    expect((e as Error).message).not.toContain("c-1");
  });

  it("cualquier otro error del servicio sigue tal cual", async () => {
    const falla = new Error("llave no disponible");
    const servicio = {
      descifrarCredencial: vi.fn(async () => {
        throw falla;
      }),
    };
    await expect(
      descifrarCredencialSol(
        { db: {} as never, servicio: servicio as never },
        trabajo,
        "c-1",
      ),
    ).rejects.toBe(falla);
  });

  it("si `usar` falla, el secreto se destruye igual y el error sigue", async () => {
    const destruir = vi.fn();
    const secreto = {
      destruir,
      usar: () => {
        throw new Error("secreto ilegible");
      },
    };
    const servicio = { descifrarCredencial: vi.fn(async () => secreto) };
    await expect(
      descifrarCredencialSol(
        { db: {} as never, servicio: servicio as never },
        trabajo,
        "c-1",
      ),
    ).rejects.toThrow("secreto ilegible");
    expect(destruir).toHaveBeenCalledTimes(1);
  });
});
