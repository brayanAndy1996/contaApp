// Spec 012b (T16a) · `ExclusionVentasService.excluir` sin BD: las carreras que la integración no puede provocar porque el advisory
// del libro serializa las exclusiones (el `ON CONFLICT DO NOTHING` ya devuelve null; el 23505 solo llegaría si otro camino
// insertara una vigente entre la lectura y la escritura). Todas terminan en 409 `ya_excluida`; cualquier otro fallo se propaga.
// El contrato HTTP completo lo cubre `exclusion.int.spec.ts`.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  excluirVenta: vi.fn(),
  leerClienteDto: vi.fn(),
  leerFilaVenta: vi.fn(),
}));
vi.mock("@contapp/domain", async (original) => ({
  ...(await original<typeof import("@contapp/domain")>()),
  erroresDeFilaVenta: vi.fn(),
  ventaAFila: vi.fn(),
}));
vi.mock("./apoyo.js", async (original) => ({
  ...(await original<typeof import("./apoyo.js")>()),
  exigirEscrituraVentas: vi.fn().mockResolvedValue(undefined),
}));

import { excluirVenta, leerClienteDto, leerFilaVenta, VentasRepoError, type Alcance } from "@contapp/db";
import { erroresDeFilaVenta } from "@contapp/domain";
import type { SesionResuelta } from "../auth/auth.service.js";
import { ExclusionVentasService } from "./exclusion.service.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const ACTOR = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const VENTA = "0190a000-0000-7000-8000-0000000000d1";
const sesion = { tenantActivo: TENANT, usuarioId: ACTOR } as SesionResuelta;
const alcance: Alcance = { tipo: "global" };
const PERMISOS: ReadonlySet<string> = new Set(["sire.clasificar"]);

function armar() {
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ tx: true })));
  return new ExclusionVentasService({ withTenant } as never);
}
const excluir = () => armar().excluir(sesion, alcance, PERMISOS, CLIENTE, "202610", VENTA, { motivo: "boleta duplicada" });

beforeEach(() => {
  vi.mocked(excluirVenta).mockReset();
  vi.mocked(leerFilaVenta).mockResolvedValue({ id: VENTA, origen: "sire", exclusion: null } as never);
  vi.mocked(leerClienteDto).mockResolvedValue({ ruc: "20100000001" } as never);
  vi.mocked(erroresDeFilaVenta).mockReturnValue([{ codigo: "IGV" }] as never);
});

describe("excluir · carreras y fallos de la inserción", () => {
  it("la exclusión que otro ya dejó vigente (insert devuelve null) es 409 ya_excluida", async () => {
    vi.mocked(excluirVenta).mockResolvedValue(null);
    await expect(excluir()).rejects.toMatchObject({ codigo: "ya_excluida" });
  });

  it("una violación del único de vigentes (23505) es 409 ya_excluida, no un 500", async () => {
    vi.mocked(excluirVenta).mockRejectedValue(new VentasRepoError("23505"));
    await expect(excluir()).rejects.toMatchObject({ codigo: "ya_excluida" });
  });

  it("otro error de la BD (23514, el trigger) se propaga sin disfrazarse de ya_excluida", async () => {
    const falla = new VentasRepoError("23514");
    vi.mocked(excluirVenta).mockRejectedValue(falla);
    await expect(excluir()).rejects.toBe(falla);
  });

  it("un error que no es de la BD tampoco se traduce", async () => {
    const falla = new Error("conexión perdida");
    vi.mocked(excluirVenta).mockRejectedValue(falla);
    await expect(excluir()).rejects.toBe(falla);
  });

  it("el motivo nunca viaja en el error de la colisión", async () => {
    vi.mocked(excluirVenta).mockRejectedValue(new VentasRepoError("23505"));
    const e = await excluir().catch((x: unknown) => x);
    expect(JSON.stringify((e as { getResponse(): unknown }).getResponse())).toBe('{"codigo":"ya_excluida"}');
  });
});
