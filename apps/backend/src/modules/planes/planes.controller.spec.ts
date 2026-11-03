import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsoPlanDto } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { PlanesController } from "./planes.controller.js";

// T11 de 006 (cobertura): GET /plan/uso pasa el estudio y el usuario de la sesión al servicio y devuelve su resultado tal cual.
const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const USUARIO = "0190a000-0000-7000-8000-0000000000b1";

describe("PlanesController", () => {
  it("uso() consulta el estudio activo de la sesión con su usuario y devuelve el DTO sin cambios", async () => {
    const dto = { plan: { codigo: "estudio", nombre: "Estudio" } } as unknown as UsoPlanDto;
    const servicio = { uso: vi.fn(async () => dto) };
    const ctl = new PlanesController(servicio as never);
    const s = { tenantActivo: TENANT, usuarioId: USUARIO } as SesionResuelta;
    expect(await ctl.uso(s)).toBe(dto);
    expect(servicio.uso).toHaveBeenCalledWith(TENANT, USUARIO);
  });

  it("el error del servicio llega tal cual al llamador", async () => {
    const error = new Error("sin_plan");
    const ctl = new PlanesController({ uso: vi.fn().mockRejectedValue(error) } as never);
    await expect(ctl.uso({ tenantActivo: TENANT, usuarioId: USUARIO } as SesionResuelta)).rejects.toBe(error);
  });
});

describe("PlanesController: metadatos del constructor", () => {
  afterEach(() => {
    vi.doUnmock("./planes.service.js");
    vi.resetModules();
  });

  // La compilacion emite `design:paramtypes` como `typeof PlanesService === "undefined" ? Object : PlanesService`; la rama
  // `Object` solo se alcanza si el modulo del servicio aun no se evaluo al decorar la clase (ciclo de imports). Se simula
  // con un doble del modulo: sin cambiar produccion y comprobando que el controlador sigue cargando.
  it("carga aunque PlanesService aun no este definido al decorar la clase (tipo del parametro = Object)", async () => {
    vi.resetModules();
    vi.doMock("./planes.service.js", () => ({ PlanesService: undefined }));
    const { PlanesController: Cargado } = await import("./planes.controller.js");
    expect(Reflect.getMetadata("design:paramtypes", Cargado)).toEqual([Object]);
    expect(Reflect.getMetadata("path", Cargado)).toBe("plan");
  });

  it("con el servicio definido, el tipo del parametro es PlanesService", async () => {
    vi.resetModules();
    const { PlanesService } = await import("./planes.service.js");
    const { PlanesController: Cargado } = await import("./planes.controller.js");
    expect(Reflect.getMetadata("design:paramtypes", Cargado)).toEqual([PlanesService]);
  });
});
