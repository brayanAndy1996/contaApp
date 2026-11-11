// Spec 012b (T16a) · `EstadoVentasService` sin BD: la rama defensiva de `aRespuestaEstado` con `marcadoEn` nulo (el SQL de
// `fijarEstadoPeriodoVentas` siempre escribe `now()`, así que la integración no la alcanza) y el orden de los orígenes. El contrato
// HTTP completo lo cubre `estado-periodo.int.spec.ts`.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  fijarEstadoPeriodoVentas: vi.fn(),
}));
vi.mock("./apoyo.js", async (original) => ({
  ...(await original<typeof import("./apoyo.js")>()),
  exigirCliente: vi.fn().mockResolvedValue(undefined),
}));

import { fijarEstadoPeriodoVentas, type Alcance } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { EstadoVentasService } from "./estado.service.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const ACTOR = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const sesion = { tenantActivo: TENANT, usuarioId: ACTOR } as SesionResuelta;
const alcance: Alcance = { tipo: "global" };
const PERMISOS: ReadonlySet<string> = new Set(["sire.aprobar_generar"]);

function armar() {
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ tx: true })));
  return new EstadoVentasService({ withTenant } as never);
}

beforeEach(() => {
  vi.mocked(fijarEstadoPeriodoVentas).mockReset();
});

describe("EstadoVentasService · respuesta del estado", () => {
  it("revisar devuelve quién y cuándo (ISO) cuando la fila trae la marca", async () => {
    const en = new Date("2026-10-05T15:30:00.000Z");
    vi.mocked(fijarEstadoPeriodoVentas).mockResolvedValue({ estado: "revisado", marcadoPor: ACTOR, marcadoEn: en });
    expect(await armar().revisar(sesion, alcance, CLIENTE, "202610")).toEqual({
      estado: "revisado",
      por: ACTOR,
      en: "2026-10-05T15:30:00.000Z",
    });
    expect(fijarEstadoPeriodoVentas).toHaveBeenCalledWith(expect.anything(), CLIENTE, "202610", "abierto", "revisado", ACTOR);
  });

  it("una fila sin marca (marcadoEn nulo) responde en: null, sin fallar", async () => {
    vi.mocked(fijarEstadoPeriodoVentas).mockResolvedValue({ estado: "abierto", marcadoPor: null, marcadoEn: null });
    expect(await armar().reabrir(sesion, alcance, PERMISOS, CLIENTE, "202610", "revisado")).toEqual({
      estado: "abierto",
      por: null,
      en: null,
    });
  });

  it("si el estado ya no es el esperado (compare-and-set devuelve null) es 409 estado_invalido", async () => {
    vi.mocked(fijarEstadoPeriodoVentas).mockResolvedValue(null);
    await expect(armar().revisar(sesion, alcance, CLIENTE, "202610")).rejects.toMatchObject({ codigo: "estado_invalido" });
  });
});
