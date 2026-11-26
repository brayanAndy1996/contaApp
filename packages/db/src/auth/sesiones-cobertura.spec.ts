// Spec 029 (T10a, CA-5): borde de SesionesRepo.revocarOtras sin BD (tx falsa): cuenta ausente o sin filas -> 0.
import { describe, expect, it } from "vitest";
import type { TxConsulta } from "./repositorio";
import { crearSesionesRepo } from "./sesiones";

const T1 = Buffer.alloc(32, 1);
const repoCon = (rows: unknown[]) =>
  crearSesionesRepo({ query: async () => ({ rows, rowCount: rows.length }) } as unknown as TxConsulta);

describe("SesionesRepo.revocarOtras: sin nada que revocar", () => {
  it("sin filas devuelve 0 (idempotente)", async () => {
    expect(await repoCon([]).revocarOtras(T1)).toBe(0);
  });

  it("una fila sin cuenta (null) tambien devuelve 0", async () => {
    expect(await repoCon([{ sesiones_revocar_otras: null }]).revocarOtras(T1)).toBe(0);
  });

  it("la cuenta que entrega la BD llega como number", async () => {
    expect(await repoCon([{ sesiones_revocar_otras: "2" }]).revocarOtras(T1)).toBe(2);
  });
});
