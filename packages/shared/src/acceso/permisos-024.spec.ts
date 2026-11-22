import { describe, expect, it } from "vitest";
import { PERMISOS, PERMISOS_POR_ROL, ROLES, alcanceDe, tienePermiso, type Rol } from "./index.js";

// Spec 024 · T1 (rojo). Permiso `buzon.atender` (plan 024; D-13; CA-6).
// Contrato: PERMISOS suma `buzon.atender` (23 en total); lo tienen Asistente, Contador, Administrador y Dueño; Lectura no.
// `buzon.marcar_leido` (leído en SUNAT, 023) queda igual: son permisos separados. El resto de la matriz de 005 no cambia.
// El tipo `Permiso` se estrecha con el catálogo; aquí se usa texto para que la prueba falle por valor y no por tipo.
const ATENDER = "buzon.atender";
const tiene = (rol: Rol, p: string) => tienePermiso(rol, p as never);

describe("permiso buzon.atender", () => {
  it("está en el catálogo, sin repetir, y el catálogo pasa a 24 (026 suma prorrata.gestionar)", () => {
    expect(PERMISOS as readonly string[]).toContain(ATENDER);
    expect(new Set(PERMISOS).size).toBe(PERMISOS.length);
    expect(PERMISOS).toHaveLength(24);
  });
  it("tiene la forma entidad.accion del resto del catálogo", () => {
    expect(ATENDER).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
  it.each<Rol>(["asistente", "contador", "admin", "dueno"])("%s puede atender", (rol) => {
    expect(tiene(rol, ATENDER)).toBe(true);
    expect((PERMISOS_POR_ROL[rol] as ReadonlySet<string>).has(ATENDER)).toBe(true);
  });
  it("lectura no puede atender", () => {
    expect(tiene("lectura", ATENDER)).toBe(false);
    expect((PERMISOS_POR_ROL.lectura as ReadonlySet<string>).has(ATENDER)).toBe(false);
  });
  it("exactamente cuatro roles lo tienen: dueno, admin, contador y asistente", () => {
    const con = ROLES.filter((r) => tiene(r, ATENDER));
    expect([...con].sort()).toEqual(["admin", "asistente", "contador", "dueno"]);
  });
  it("quien atiende puede ver el buzón (buzon.ver) y los clientes", () => {
    for (const rol of ROLES) {
      if (tiene(rol, ATENDER)) {
        expect(tiene(rol, "buzon.ver")).toBe(true);
        expect(tiene(rol, "clientes.ver")).toBe(true);
      }
    }
  });
  it("es un permiso distinto de buzon.marcar_leido: no es un alias", () => {
    expect(ATENDER).not.toBe("buzon.marcar_leido");
    expect(PERMISOS as readonly string[]).toContain("buzon.marcar_leido");
  });
});

describe("buzon.marcar_leido no cambia", () => {
  it.each<Rol>(["dueno", "admin", "contador", "asistente"])("%s lo conserva", (rol) => {
    expect(tiene(rol, "buzon.marcar_leido")).toBe(true);
  });
  it("lectura sigue sin él", () => {
    expect(tiene("lectura", "buzon.marcar_leido")).toBe(false);
  });
});

describe("el resto de la matriz de roles sigue igual", () => {
  // 026 suma `prorrata.gestionar` a contador, admin y dueno: se excluye junto con `buzon.atender` para comparar lo de 024.
  const SIN_ATENDER = (rol: Rol) => [...PERMISOS_POR_ROL[rol]].filter((p) => (p as string) !== ATENDER && (p as string) !== "prorrata.gestionar").sort();
  it("lectura conserva exactamente sus 4 permisos", () => {
    expect(SIN_ATENDER("lectura")).toEqual(["buzon.ver", "clientes.ver", "prorrata.ver", "reglas.ver"]);
    expect(PERMISOS_POR_ROL.lectura.size).toBe(4);
  });
  it("asistente suma solo buzon.atender a sus 7 permisos de antes", () => {
    expect(SIN_ATENDER("asistente")).toEqual(
      ["buzon.marcar_leido", "buzon.ver", "clientes.ver", "prorrata.ver", "reglas.ver", "sire.clasificar", "sire.descargar"].sort(),
    );
    expect(PERMISOS_POR_ROL.asistente.size).toBe(8);
  });
  it("contador suma solo buzon.atender a sus 12 permisos de antes", () => {
    expect(PERMISOS_POR_ROL.contador.size).toBe(14); // 12 + buzon.atender + prorrata.gestionar (026)
    expect(SIN_ATENDER("contador")).toHaveLength(12);
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
