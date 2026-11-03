import "reflect-metadata";
import { AuthRepoError, PlataformaReglaError, type PlanFila } from "@contapp/db";
import { describe, expect, it, vi } from "vitest";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { hashToken } from "../auth/sesion/token.js";
import { PlataformaService } from "./plataforma.service.js";

// T11 de 006 (cobertura): traducción de errores y validación de entrada del super-admin con dobles (sin BD ni HTTP).
// El comportamiento completo contra la BD lo cubre plataforma.int.spec.ts.
const ADMIN = "0190a000-0000-7000-8000-0000000000c1";
const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const PLAN_ID = "0190a000-0000-7000-8000-0000000000d1";
const sesion = { token: "T".repeat(43), usuarioId: ADMIN, tenantActivo: null } as unknown as SesionResuelta;

const FILA: PlanFila = {
  id: PLAN_ID,
  codigo: "estudio",
  nombre: "Estudio",
  precioMensual: "249.00",
  precioAnual: null,
  maxRucs: 100,
  maxUsuarios: null,
  precioRucExtra: "4.00",
  maxRucsExtra: 20,
  frecuenciaBuzonMin: 720,
  features: {},
  activo: true,
};
const CUERPO_PLAN = {
  codigo: "estudio",
  nombre: "Estudio",
  precioMensual: "249.00",
  precioAnual: null,
  maxRucs: 100,
  maxUsuarios: null,
  precioRucExtra: "4.00",
  maxRucsExtra: 20,
  frecuenciaBuzonMin: 720,
  features: {},
  activo: true,
};

function armar(esAdmin = true) {
  const repo = {
    plataformaYo: vi.fn(async () => (esAdmin ? ADMIN : null)),
    planListar: vi.fn(async () => [FILA]),
    planCrear: vi.fn(async () => FILA),
    planEditar: vi.fn(async () => FILA),
    estudiosListar: vi.fn(async () => [
      { id: TENANT, nombre: "E", plan: null, estado: null },
    ]),
    suscripcionAsignar: vi.fn(async () => ({
      tenantId: TENANT,
      planId: PLAN_ID,
      planCodigo: "estudio",
      planNombre: "Estudio",
      estado: "activa" as const,
      rucsExtraContratados: 2,
    })),
  };
  const db = { withAuth: vi.fn(async (fn: (a: unknown) => unknown) => fn(repo)) };
  return { servicio: new PlataformaService(db as never), repo, db };
}
const fallo = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as { codigo?: string };

describe("PlataformaService: operaciones con alta de plataforma", () => {
  it("yo() confirma al admin y valida el alta con el hash de la sesión (nunca el token en claro)", async () => {
    const { servicio, repo } = armar();
    expect(await servicio.yo(sesion)).toEqual({ admin: true });
    expect(repo.plataformaYo).toHaveBeenCalledWith(hashToken(sesion.token));
  });

  it("listarPlanes, crearPlan y editarPlan devuelven el DTO del plan; editarPlan normaliza el id a minúsculas", async () => {
    const { servicio, repo } = armar();
    expect((await servicio.listarPlanes(sesion))[0]).toMatchObject({ id: PLAN_ID, codigo: "estudio", precioAnual: null });
    expect(await servicio.crearPlan(sesion, CUERPO_PLAN)).toMatchObject({ codigo: "estudio", maxUsuarios: null });
    await servicio.editarPlan(sesion, PLAN_ID.toUpperCase(), CUERPO_PLAN);
    expect(repo.planEditar).toHaveBeenCalledWith(hashToken(sesion.token), PLAN_ID, expect.objectContaining({ codigo: "estudio" }));
  });

  it("listarEstudios y asignarSuscripcion devuelven solo los campos del contrato", async () => {
    const { servicio } = armar();
    expect(await servicio.listarEstudios(sesion)).toEqual([{ id: TENANT, nombre: "E", plan: null, estado: null }]);
    expect(await servicio.asignarSuscripcion(sesion, TENANT, { planId: PLAN_ID, rucsExtraContratados: 2 })).toEqual({
      estudioId: TENANT,
      plan: { codigo: "estudio", nombre: "Estudio" },
      estado: "activa",
      rucsExtraContratados: 2,
    });
  });
});

describe("PlataformaService: quien no es admin recibe el mismo 403 con cualquier entrada", () => {
  it.each([
    ["yo", (s: PlataformaService) => s.yo(sesion)],
    ["listarPlanes", (s: PlataformaService) => s.listarPlanes(sesion)],
    ["crearPlan (cuerpo inválido)", (s: PlataformaService) => s.crearPlan(sesion, "basura")],
    ["editarPlan (id inválido)", (s: PlataformaService) => s.editarPlan(sesion, "no-uuid", null)],
    ["listarEstudios", (s: PlataformaService) => s.listarEstudios(sesion)],
    ["asignarSuscripcion (todo inválido)", (s: PlataformaService) => s.asignarSuscripcion(sesion, undefined, 7)],
  ])("%s -> permiso_denegado sin llamar a la función de plataforma", async (_n, llamar) => {
    const { servicio, repo } = armar(false);
    const e = await llamar(servicio).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccesoError);
    expect((e as AccesoError).codigo).toBe("permiso_denegado");
    expect(e).not.toBeInstanceOf(AuthRepoError);
    for (const f of [repo.planListar, repo.planCrear, repo.planEditar, repo.estudiosListar, repo.suscripcionAsignar])
      expect(f).not.toHaveBeenCalled();
  });
});

describe("PlataformaService: validación de la entrada (admin)", () => {
  it("cuerpo de plan inválido -> solicitud_invalida; id o estudio fuera de formato -> no_encontrado", async () => {
    const { servicio, repo } = armar();
    expect((await fallo(servicio.crearPlan(sesion, { codigo: "x" }))).codigo).toBe("solicitud_invalida");
    expect((await fallo(servicio.editarPlan(sesion, "no-uuid", CUERPO_PLAN))).codigo).toBe("no_encontrado");
    expect((await fallo(servicio.editarPlan(sesion, undefined, CUERPO_PLAN))).codigo).toBe("no_encontrado");
    expect((await fallo(servicio.editarPlan(sesion, PLAN_ID, { codigo: "x" }))).codigo).toBe("solicitud_invalida");
    expect((await fallo(servicio.asignarSuscripcion(sesion, "no-uuid", {}))).codigo).toBe("no_encontrado");
    expect((await fallo(servicio.asignarSuscripcion(sesion, TENANT, { planId: "x" }))).codigo).toBe("solicitud_invalida");
    expect(repo.planCrear).not.toHaveBeenCalled();
    expect(repo.suscripcionAsignar).not.toHaveBeenCalled();
  });
});

describe("PlataformaService: traducción de los rechazos de la BD (sin eco)", () => {
  const casos: Array<[string, Error, string, number]> = [
    ["regla no_encontrado", new PlataformaReglaError("no_encontrado"), "no_encontrado", 404],
    ["regla plan_inactivo", new PlataformaReglaError("plan_inactivo"), "plan_inactivo", 409],
    ["regla extra_sobre_tope", new PlataformaReglaError("extra_sobre_tope"), "solicitud_invalida", 400],
    ["42501 (sin alta)", new AuthRepoError("42501"), "permiso_denegado", 403],
    ["23514 (CHECK)", new AuthRepoError("23514"), "solicitud_invalida", 400],
    ["23505 (código repetido)", new AuthRepoError("23505"), "codigo_existente", 409],
  ];

  it.each(casos)("%s -> %s", async (_n, error, codigo, estado) => {
    const { servicio, repo } = armar();
    repo.suscripcionAsignar.mockRejectedValueOnce(error as never);
    const e = (await servicio
      .asignarSuscripcion(sesion, TENANT, { planId: PLAN_ID, rucsExtraContratados: 0 })
      .catch((x: unknown) => x)) as AccesoError;
    expect(e).toBeInstanceOf(AccesoError);
    expect(e.codigo).toBe(codigo);
    expect(e.getStatus()).toBe(estado);
  });

  it("también al crear un plan con código repetido -> 409 codigo_existente", async () => {
    const { servicio, repo } = armar();
    repo.planCrear.mockRejectedValueOnce(new AuthRepoError("23505") as never);
    expect((await fallo(servicio.crearPlan(sesion, CUERPO_PLAN))).codigo).toBe("codigo_existente");
  });

  it("un AuthRepoError con otro SQLSTATE y los errores ajenos siguen igual (500)", async () => {
    const { servicio, repo } = armar();
    const otro = new AuthRepoError("40001");
    repo.planListar.mockRejectedValueOnce(otro as never);
    expect(await servicio.listarPlanes(sesion).catch((x: unknown) => x)).toBe(otro);
    const ajeno = new TypeError("caída");
    repo.estudiosListar.mockRejectedValueOnce(ajeno as never);
    expect(await servicio.listarEstudios(sesion).catch((x: unknown) => x)).toBe(ajeno);
  });
});
