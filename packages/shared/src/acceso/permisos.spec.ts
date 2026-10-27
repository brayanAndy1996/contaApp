import { describe, expect, it } from "vitest";
import {
  PERMISOS,
  PERMISOS_POR_ROL,
  ROLES,
  tienePermiso,
  type Permiso,
  type Rol,
} from "./index.js";

// Contrato (plan 005, packages/shared/src/acceso): catalogo de 22 permisos (01 §4), 5 roles de
// sistema y la matriz de D2/D17. Se prueba por TABLA 5 roles x 22 permisos (CA-1). La lista
// esperada se escribe aqui a mano, no se deriva de la implementacion.
const TODOS = [
  "estudio.configurar",
  "plan.gestionar",
  "usuarios.ver",
  "usuarios.gestionar",
  "roles.gestionar",
  "clientes.ver",
  "clientes.crear",
  "clientes.editar",
  "clientes.archivar",
  "clientes.asignar",
  "credenciales.editar",
  "sire.descargar",
  "sire.clasificar",
  "sire.aprobar_generar",
  "ajustes.crear",
  "ajustes.generar",
  "buzon.ver",
  "buzon.marcar_leido",
  "reglas.ver",
  "reglas.gestionar",
  "prorrata.ver",
  "auditoria.ver",
] as const satisfies readonly Permiso[];

const ESPERADOS: Record<Rol, readonly Permiso[]> = {
  dueno: TODOS,
  admin: TODOS.filter((p) => p !== "plan.gestionar"),
  contador: [
    "clientes.ver",
    "credenciales.editar",
    "sire.descargar",
    "sire.clasificar",
    "sire.aprobar_generar",
    "ajustes.crear",
    "ajustes.generar",
    "buzon.ver",
    "buzon.marcar_leido",
    "reglas.ver",
    "reglas.gestionar",
    "prorrata.ver",
  ],
  asistente: [
    "clientes.ver",
    "sire.descargar",
    "sire.clasificar",
    "buzon.ver",
    "buzon.marcar_leido",
    "reglas.ver",
    "prorrata.ver",
  ],
  lectura: ["clientes.ver", "buzon.ver", "reglas.ver", "prorrata.ver"],
};

describe("catalogo de permisos (01 §4)", () => {
  it("son exactamente los 22 permisos atomicos, sin repetidos", () => {
    expect(PERMISOS).toHaveLength(22);
    expect(new Set(PERMISOS).size).toBe(22);
    expect([...PERMISOS].sort()).toEqual([...TODOS].sort());
  });

  it("los roles de sistema son 5 y en este orden", () => {
    expect([...ROLES]).toEqual([
      "dueno",
      "admin",
      "contador",
      "asistente",
      "lectura",
    ]);
  });

  it("la matriz tiene una entrada por rol y ningun permiso fuera del catalogo", () => {
    expect(Object.keys(PERMISOS_POR_ROL).sort()).toEqual([...ROLES].sort());
    for (const rol of ROLES) {
      for (const p of PERMISOS_POR_ROL[rol]) expect(TODOS).toContain(p);
    }
  });
});

describe("matriz rol x permiso (D2, D17, CA-1): tabla 5 x 22", () => {
  const casos = ROLES.flatMap((rol) =>
    TODOS.map(
      (permiso) => [rol, permiso, ESPERADOS[rol].includes(permiso)] as const,
    ),
  );
  it("la tabla cubre 5 x 22 = 110 casos", () => {
    expect(casos).toHaveLength(110);
  });

  it.each(casos)("%s / %s -> %s", (rol, permiso, esperado) => {
    expect(tienePermiso(rol, permiso)).toBe(esperado);
    expect(PERMISOS_POR_ROL[rol].has(permiso)).toBe(esperado);
  });

  it.each([
    ["dueno", 22],
    ["admin", 21],
    ["contador", 12],
    ["asistente", 7],
    ["lectura", 4],
  ] as const)("%s tiene %i permisos", (rol, n) => {
    expect(PERMISOS_POR_ROL[rol].size).toBe(n);
  });

  it("solo el Dueno tiene plan.gestionar; usuarios.* y auditoria.ver solo Dueno y Administrador", () => {
    for (const rol of ROLES) {
      expect(tienePermiso(rol, "plan.gestionar")).toBe(rol === "dueno");
      for (const p of [
        "usuarios.ver",
        "usuarios.gestionar",
        "roles.gestionar",
        "auditoria.ver",
      ] as const) {
        expect(tienePermiso(rol, p)).toBe(rol === "dueno" || rol === "admin");
      }
    }
  });

  it("solo Dueno y Administrador asignan clientes; asistente y lectura no aprueban ni editan credenciales", () => {
    for (const rol of ROLES) {
      expect(tienePermiso(rol, "clientes.asignar")).toBe(
        rol === "dueno" || rol === "admin",
      );
    }
    for (const rol of ["asistente", "lectura"] as const) {
      expect(tienePermiso(rol, "sire.aprobar_generar")).toBe(false);
      expect(tienePermiso(rol, "credenciales.editar")).toBe(false);
    }
  });

  it("los roles forman una cadena: cada uno contiene los permisos del siguiente", () => {
    for (let i = 0; i < ROLES.length - 1; i++) {
      const mayor = PERMISOS_POR_ROL[ROLES[i] as Rol];
      const menor = PERMISOS_POR_ROL[ROLES[i + 1] as Rol];
      for (const p of menor) expect(mayor.has(p)).toBe(true);
    }
  });

  it("un rol desconocido no tiene ningun permiso", () => {
    expect(tienePermiso("superadmin" as Rol, "clientes.ver")).toBe(false);
  });
});
