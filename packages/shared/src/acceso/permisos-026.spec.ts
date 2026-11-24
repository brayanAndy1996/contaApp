import { describe, expect, it } from "vitest";
import { PERMISOS, PERMISOS_POR_ROL, ROLES, alcanceDe, tienePermiso, type Rol } from "./index.js";

// Spec 026 · T2 (rojo). Permiso `prorrata.gestionar` (spec 026 D-5, U-11; plan 026, Contratos: shared; CA-9).
// Contrato: PERMISOS suma `prorrata.gestionar` (24 en total); lo tienen Dueño, Administrador y Contador; Asistente y Lectura no
// (solo `prorrata.ver`). Es un permiso distinto de `prorrata.ver`: obtener declaraciones, guardar o eliminar un mes manual y guardar la
// prorrata usada exigen `gestionar`; ver la pantalla, `ver`. El resto de la matriz de 005, 021 y 024 no cambia.
// El tipo `Permiso` se estrecha con el catálogo; aquí se usa texto para que la prueba falle por valor y no por tipo.
const GESTIONAR = "prorrata.gestionar";
const tiene = (rol: Rol, p: string) => tienePermiso(rol, p as never);

describe("permiso prorrata.gestionar", () => {
  it("está en el catálogo, sin repetir, y el catálogo pasa a 24", () => {
    expect(PERMISOS as readonly string[]).toContain(GESTIONAR);
    expect(new Set(PERMISOS).size).toBe(PERMISOS.length);
    expect(PERMISOS).toHaveLength(24);
  });
  it("tiene la forma entidad.accion del resto del catálogo", () => {
    expect(GESTIONAR).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
  it.each<Rol>(["dueno", "admin", "contador"])("%s puede gestionar la prorrata", (rol) => {
    expect(tiene(rol, GESTIONAR)).toBe(true);
    expect((PERMISOS_POR_ROL[rol] as ReadonlySet<string>).has(GESTIONAR)).toBe(true);
  });
  it.each<Rol>(["asistente", "lectura"])("%s no puede gestionar la prorrata (solo la ve)", (rol) => {
    expect(tiene(rol, GESTIONAR)).toBe(false);
    expect((PERMISOS_POR_ROL[rol] as ReadonlySet<string>).has(GESTIONAR)).toBe(false);
    expect(tiene(rol, "prorrata.ver")).toBe(true);
  });
  it("exactamente tres roles lo tienen: dueno, admin y contador (U-11)", () => {
    const con = ROLES.filter((r) => tiene(r, GESTIONAR));
    expect([...con].sort()).toEqual(["admin", "contador", "dueno"]);
  });
  it("quien gestiona puede ver la prorrata (prorrata.ver) y los clientes", () => {
    for (const rol of ROLES) {
      if (tiene(rol, GESTIONAR)) {
        expect(tiene(rol, "prorrata.ver")).toBe(true);
        expect(tiene(rol, "clientes.ver")).toBe(true);
      }
    }
  });
  it("es un permiso distinto de prorrata.ver: no es un alias", () => {
    expect(GESTIONAR).not.toBe("prorrata.ver");
    expect(PERMISOS as readonly string[]).toContain("prorrata.ver");
  });
  it("sigue siendo independiente de los permisos de otras funciones: no sustituye a reglas.gestionar ni a buzon.atender", () => {
    expect(GESTIONAR).not.toBe("reglas.gestionar");
    expect(GESTIONAR).not.toBe("buzon.atender");
    expect(tiene("asistente", "buzon.atender")).toBe(true);
    expect(tiene("asistente", GESTIONAR)).toBe(false);
  });
});

describe("prorrata.ver no cambia", () => {
  it.each<Rol>(["dueno", "admin", "contador", "asistente", "lectura"])("%s lo conserva", (rol) => {
    expect(tiene(rol, "prorrata.ver")).toBe(true);
  });
});

describe("el resto de la matriz de roles sigue igual", () => {
  const SIN_GESTIONAR = (rol: Rol) => [...PERMISOS_POR_ROL[rol]].filter((p) => (p as string) !== GESTIONAR).sort();
  it("lectura conserva exactamente sus 4 permisos", () => {
    expect(SIN_GESTIONAR("lectura")).toEqual(["buzon.ver", "clientes.ver", "prorrata.ver", "reglas.ver"]);
    expect(PERMISOS_POR_ROL.lectura.size).toBe(4);
  });
  it("asistente conserva exactamente sus 8 permisos", () => {
    expect(SIN_GESTIONAR("asistente")).toEqual(
      ["buzon.atender", "buzon.marcar_leido", "buzon.ver", "clientes.ver", "prorrata.ver", "reglas.ver", "sire.clasificar", "sire.descargar"].sort(),
    );
    expect(PERMISOS_POR_ROL.asistente.size).toBe(8);
  });
  it("contador suma solo prorrata.gestionar a sus 13 permisos de antes", () => {
    expect(SIN_GESTIONAR("contador")).toHaveLength(13);
    expect(PERMISOS_POR_ROL.contador.size).toBe(14);
  });
  it("admin tiene todo menos plan.gestionar; dueno tiene todo", () => {
    expect(PERMISOS_POR_ROL.dueno.size).toBe(24);
    expect(PERMISOS_POR_ROL.admin.size).toBe(23);
    expect(tiene("admin", "plan.gestionar")).toBe(false);
    expect(tiene("dueno", "plan.gestionar")).toBe(true);
  });
  it("el alcance no cambia: dueno y admin globales; el resto, asignado", () => {
    expect(alcanceDe("dueno")).toBe("global");
    expect(alcanceDe("admin")).toBe("global");
    for (const rol of ["contador", "asistente", "lectura"] as const) expect(alcanceDe(rol)).toBe("asignado");
  });
});
