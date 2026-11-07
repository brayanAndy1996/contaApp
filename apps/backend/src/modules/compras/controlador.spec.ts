// Spec 014 (T16): los controladores de compras no atienden una petición sin acceso resuelto (no debería ocurrir: `PermisoGuard`
// lo fija antes). Sin BD.
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AccesoError } from "../acceso/errores.js";
import type { PeticionAcceso } from "../acceso/guards/decoradores.js";
import { ComprasAccionesController, accesoDe } from "./compras-acciones.controller.js";
import { ComprasController } from "./compras.controller.js";

const SESION = {} as never;
const SIN_ACCESO: PeticionAcceso = {};

describe("accesoDe", () => {
  it("sin acceso resuelto es 403 permiso_denegado", () => {
    expect(() => accesoDe(SIN_ACCESO)).toThrow(AccesoError);
  });

  it("con acceso devuelve el alcance y los permisos", () => {
    const permisos = new Set(["sire.clasificar"]) as never;
    const [alcance, p] = accesoDe({ acceso: { usuarioId: "u", rol: "contador", permisos, alcance: "global" } } as PeticionAcceso);
    expect(alcance).toEqual({ tipo: "global" });
    expect(p).toBe(permisos);
  });
});

describe("controladores", () => {
  it("una ruta de acciones sin acceso resuelto no llega al servicio", () => {
    const c = new ComprasAccionesController({} as never, {} as never, {} as never, {} as never);
    expect(() => c.deshacer(SESION, SIN_ACCESO, "c", "202610")).toThrow(AccesoError);
  });

  it("descargar sin acceso resuelto tampoco", () => {
    const c = new ComprasController({} as never, {} as never);
    expect(() => c.descargar(SESION, SIN_ACCESO, "c", "202610")).toThrow(AccesoError);
  });
});
