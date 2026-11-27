// Spec 030 (T8) · `efectivo.ts`: resolución de permisos efectivos de una membresía leída (sistema o propio), falla cerrado, y relectura
// tras el bloqueo con una sola consulta solo si hay roles propios. Sin BD.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { definicionesDe } = vi.hoisted(() => ({ definicionesDe: vi.fn() }));
vi.mock("@contapp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@contapp/db")>()),
  definicionesDe: (...a: unknown[]) => definicionesDe(...a),
}));

import type { MiembroEstado } from "@contapp/db";
import { efectivoExigeFactor } from "../auth/totp/exigencia.js";
import { efectivoDe, releerEfectivos, tiene } from "./efectivo.js";

const U1 = "0190a000-0000-7000-8000-0000000000a1";
const U2 = "0190a000-0000-7000-8000-0000000000a2";
const R1 = "0190a000-0000-7000-8000-0000000000f1";
const estado = (usuarioId: string, rol: string): MiembroEstado => ({ usuarioId, rol, activo: true }) as MiembroEstado;

beforeEach(() => definicionesDe.mockReset());

describe("efectivoDe", () => {
  it("rol de sistema: su fila de la matriz y su alcance; rol propio: sus permisos y alcance", () => {
    const d = efectivoDe({ rol: "dueno" });
    expect(d).toMatchObject({ rolSistema: "dueno", alcance: "global" });
    expect(d?.permisos.has("plan.gestionar")).toBe(true);
    const p = efectivoDe({ rol: "propio", propio: { permisos: ["clientes.ver"], alcance: "global" } });
    expect(p).toMatchObject({ rolSistema: null, alcance: "global" });
    expect([...(p?.permisos ?? [])]).toEqual(["clientes.ver"]);
  });

  it("falla cerrado: sin membresía, rol desconocido o propio sin definición -> null; permisos fuera del catálogo se descartan", () => {
    expect(efectivoDe(null)).toBeNull();
    expect(efectivoDe(undefined)).toBeNull();
    expect(efectivoDe({ rol: "superdueno" as never })).toBeNull();
    expect(efectivoDe({ rol: "propio" })).toBeNull();
    expect(efectivoDe({ rol: "propio", propio: null })).toBeNull();
    const raro = efectivoDe({ rol: "propio", propio: { permisos: ["plan.inventado", "buzon.ver"], alcance: "otro" as never } });
    expect([...(raro?.permisos ?? [])]).toEqual(["buzon.ver"]);
    expect(raro?.alcance).toBe("asignado");
  });

  it("tiene() y la exigencia de TOTP con permisos efectivos (null exige)", () => {
    expect(tiene(null, "clientes.ver")).toBe(false);
    expect(tiene(efectivoDe({ rol: "lectura" }), "clientes.ver")).toBe(true);
    expect(efectivoExigeFactor(null)).toBe(true);
    expect(efectivoExigeFactor(efectivoDe({ rol: "admin" }))).toBe(true);
    expect(efectivoExigeFactor(efectivoDe({ rol: "contador" }))).toBe(false);
    expect(efectivoExigeFactor(efectivoDe({ rol: "propio", propio: { permisos: ["usuarios.ver", "usuarios.gestionar"], alcance: "asignado" } }))).toBe(true);
    expect(efectivoExigeFactor(efectivoDe({ rol: "propio", propio: { permisos: ["clientes.ver"], alcance: "global" } }))).toBe(false);
  });
});

describe("releerEfectivos", () => {
  it("solo roles de sistema: sin consulta", async () => {
    const r = await releerEfectivos({ query: vi.fn() }, new Map([[U1, estado(U1, "admin")]]));
    expect(definicionesDe).not.toHaveBeenCalled();
    expect(r.get(U1)).toMatchObject({ rolId: null, efectivo: { rolSistema: "admin" } });
  });

  it("con roles propios: una consulta para ellos; un propio sin definición queda en null (falla cerrado)", async () => {
    definicionesDe.mockResolvedValue(
      new Map([[U1, { rol: "propio", rolId: R1, propio: { permisos: ["clientes.ver"], alcance: "asignado" } }]]),
    );
    const r = await releerEfectivos(
      { query: vi.fn() },
      new Map([
        [U1, estado(U1, "propio")],
        [U2, estado(U2, "propio")],
      ]),
    );
    expect(definicionesDe).toHaveBeenCalledTimes(1);
    expect(definicionesDe.mock.calls[0]?.[1]).toEqual([U1, U2]);
    expect(r.get(U1)).toMatchObject({ rolId: R1, efectivo: { rolSistema: null, alcance: "asignado" } });
    expect(r.get(U2)).toMatchObject({ rolId: null, efectivo: null });
  });
});
