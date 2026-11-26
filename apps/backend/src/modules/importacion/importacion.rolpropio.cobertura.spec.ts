// Spec 030 (T14): la importación de clientes con miembros de rol propio (D3), sin BD. El actor y el responsable se resuelven por sus
// permisos efectivos: un rol propio con `clientes.crear` importa, sin él recibe 403; con `sire.clasificar` puede ser responsable.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  listarMiembros: vi.fn(),
  definicionesDe: vi.fn(),
  rucsExistentes: vi.fn(),
}));

import { definicionesDe, listarMiembros, rucsExistentes } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { csv, CABECERA, filaDatos, rucConPrefijo } from "../../../test/soporte-importacion.js";
import { ImportacionService } from "./importacion.service.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const ACTOR = "0190a000-0000-7000-8000-0000000000B1";
const OTRO = "0190a000-0000-7000-8000-0000000000c1";
const sesion = { tenantActivo: TENANT, usuarioId: ACTOR } as SesionResuelta;
const RUC = rucConPrefijo("20", 321);

const servicio = () =>
  new ImportacionService(
    { withTenant: (_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ tx: true })) } as never,
    { libres: vi.fn().mockResolvedValue(5), reservar: vi.fn() } as never,
    vi.fn() as never,
    { encolarLote: vi.fn() } as never,
  );
const archivo = (...filas: Array<Parameters<typeof filaDatos>[0]>) =>
  Buffer.from(csv([[...CABECERA], ...filas.map(filaDatos)]));
const miembro = (usuarioId: string, correo: string, rol: string) => ({ usuarioId, nombre: correo, correo, rol, activo: true });
const definicion = (permisos: string[], alcance: "global" | "asignado" = "global") => ({
  rol: "propio" as const,
  rolId: "0190a000-0000-7000-8000-0000000000d1",
  propio: { permisos, alcance },
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(rucsExistentes).mockResolvedValue([]);
});

describe("importación con roles propios (D3)", () => {
  it("un actor con rol propio que tiene clientes.crear obtiene la vista previa; un responsable propio con sire.clasificar es válido", async () => {
    vi.mocked(listarMiembros).mockResolvedValue([
      miembro(ACTOR, "actor@x.test", "propio"),
      miembro(OTRO, "resp@x.test", "propio"),
    ] as never);
    vi.mocked(definicionesDe).mockResolvedValue(
      new Map([
        [ACTOR.toLowerCase(), definicion(["clientes.ver", "clientes.crear"])],
        [OTRO, definicion(["clientes.ver", "sire.ver", "sire.clasificar"], "asignado")],
      ]) as never,
    );
    const r = await servicio().vistaPrevia(sesion, archivo({ ruc: RUC, responsable: "resp@x.test" }));
    expect(r.filas).toMatchObject([{ n: 2, estado: "valida", motivos: [] }]);
    expect(vi.mocked(definicionesDe).mock.calls[0]![1]).toEqual([ACTOR, OTRO]);
  });

  it("un responsable propio sin sire.clasificar, o cuya definición ya no existe, no es asignable", async () => {
    vi.mocked(listarMiembros).mockResolvedValue([
      miembro(ACTOR, "actor@x.test", "propio"),
      miembro(OTRO, "sinclasif@x.test", "propio"),
      miembro("0190a000-0000-7000-8000-0000000000e1", "huerfano@x.test", "propio"),
    ] as never);
    vi.mocked(definicionesDe).mockResolvedValue(
      new Map([
        [ACTOR.toLowerCase(), definicion(["clientes.ver", "clientes.crear"])],
        [OTRO, definicion(["clientes.ver"])],
      ]) as never,
    );
    const r = await servicio().vistaPrevia(
      sesion,
      archivo(
        { ruc: RUC, responsable: "sinclasif@x.test" },
        { ruc: rucConPrefijo("20", 322), responsable: "huerfano@x.test" },
      ),
    );
    expect(r.filas).toMatchObject([
      { n: 2, estado: "error", motivos: ["responsable_no_asignable"] },
      { n: 3, estado: "error", motivos: ["responsable_no_asignable"] },
    ]);
  });

  it("un actor con rol propio sin clientes.crear, o sin definición, recibe permiso_denegado", async () => {
    vi.mocked(listarMiembros).mockResolvedValue([miembro(ACTOR, "actor@x.test", "propio")] as never);
    vi.mocked(definicionesDe).mockResolvedValue(new Map([[ACTOR.toLowerCase(), definicion(["clientes.ver"])]]) as never);
    await expect(servicio().vistaPrevia(sesion, archivo({ ruc: RUC }))).rejects.toMatchObject({ codigo: "permiso_denegado" });
    vi.mocked(definicionesDe).mockResolvedValue(new Map() as never);
    await expect(servicio().vistaPrevia(sesion, archivo({ ruc: RUC }))).rejects.toMatchObject({ codigo: "permiso_denegado" });
  });

  it("un actor con rol propio y clientes.crear pero sin credenciales.editar recibe permiso_denegado si el archivo trae claves", async () => {
    vi.mocked(listarMiembros).mockResolvedValue([miembro(ACTOR, "actor@x.test", "propio")] as never);
    vi.mocked(definicionesDe).mockResolvedValue(
      new Map([[ACTOR.toLowerCase(), definicion(["clientes.ver", "clientes.crear"])]]) as never,
    );
    await expect(
      servicio().vistaPrevia(sesion, archivo({ ruc: RUC, usuarioSol: "U", claveSol: "K" })),
    ).rejects.toMatchObject({ codigo: "permiso_denegado" });
  });
});
