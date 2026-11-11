// Spec 017 (T14a, D-12): `autoresDe` y `autorDe` sin BD. Un id que no se resolvió es un desconocido, nunca un hueco.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  resolverAutores: vi.fn(),
}));

import { resolverAutores } from "@contapp/db";
import { autorDe, autoresDe } from "./autor.js";

const A = "0190a000-0000-7000-8000-0000000000b1";
const B = "0190a000-0000-7000-8000-0000000000b2";

describe("autoresDe", () => {
  beforeEach(() => vi.mocked(resolverAutores).mockReset());

  it("resuelve en una sola consulta solo los ids no nulos", async () => {
    const mapa = new Map([[A, { id: A, nombre: "Ana", activo: true }]]);
    vi.mocked(resolverAutores).mockResolvedValue(mapa);
    const tx = { tx: 1 } as never;
    const r = await autoresDe(tx, [A, null, B, null]);
    expect(r).toBe(mapa);
    expect(resolverAutores).toHaveBeenCalledTimes(1);
    expect(resolverAutores).toHaveBeenCalledWith(tx, [A, B]);
  });

  it("una lista solo de nulos consulta con una lista vacía", async () => {
    vi.mocked(resolverAutores).mockResolvedValue(new Map());
    await autoresDe({} as never, [null, null]);
    expect(resolverAutores).toHaveBeenCalledWith({}, []);
  });
});

describe("autorDe", () => {
  const autores = new Map([[A, { id: A, nombre: "Ana", activo: true }]]);

  it("un id nulo no tiene autor", () => {
    expect(autorDe(autores, null)).toBeNull();
  });

  it("un id resuelto devuelve su autor", () => {
    expect(autorDe(autores, A)).toEqual({ id: A, nombre: "Ana", activo: true });
  });

  it("un id sin resolver es un desconocido: id conservado, sin nombre e inactivo", () => {
    expect(autorDe(autores, B)).toEqual({ id: B, nombre: null, activo: false });
  });
});
