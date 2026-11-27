import { describe, expect, it } from "vitest";
import {
  alcanceDe,
  PERMISOS,
  PERMISOS_POR_ROL,
  puedeSerResponsable,
  ROLES,
  type Permiso,
} from "./index.js";
import { alcanceEfectivo, permisosEfectivos, type Efectivo } from "./efectivos.js";
import { validarCombinacion } from "./combinacion.js";
import {
  CASOS_EFECTIVOS,
  PERMISOS_ASIGNABLES,
  REGLAS_U3,
  type CasoEfectivo,
} from "./efectivos.casos.js";
import { factorExigido } from "../auth/seguridad.js";

// Spec 030 · T2 (rojo). Contrato fijado por estas pruebas (plan 030, Contratos: Shared; spec D3, U2, U3, U7, CA-4, CA-7).
//
// Contrato — packages/shared/src/acceso/efectivos.ts (T7), exportado también por `acceso/index.ts`:
//   type Efectivo = { rolSistema: Rol | null; permisos: ReadonlySet<Permiso>; alcance: 'global' | 'asignado' }
//     rolSistema = clave del rol de sistema, o `null` si es un rol propio (U7: un rol propio nunca cuenta como Dueño).
//   permisosEfectivos(rol: Rol | 'propio', propio?: { permisos: readonly Permiso[]; alcance: 'global' | 'asignado' }): Efectivo
//     - rol de sistema → su fila de PERMISOS_POR_ROL y `alcanceDe(rol)`; `propio` se ignora si viene.
//     - 'propio' → `propio.permisos` (copia, sin alias) y `propio.alcance`; `rolSistema: null`. 'propio' sin `propio` LANZA Error.
//     - Un rol propio vacío es válido (conjunto vacío).
//   alcanceEfectivo(e: Efectivo): 'global' | 'asignado'   (= e.alcance)
//   puedeSerResponsable(x: Rol | Efectivo): boolean       (D18: tiene `sire.clasificar`; la exportada por `acceso/index.ts`
//                                                          acepta ambas formas para no romper las llamadas de 005)
// Tabla común TS/SQL: `efectivos.casos.ts` (CASOS_EFECTIVOS, REGLAS_U3, PERMISOS_ASIGNABLES). T1/T6 usan la misma tabla contra
// `acceso.permisos_membresia(tenant, usuario) → (rol_sistema, permisos text[], alcance)`.
// Rojas por el módulo ausente `./efectivos.js` (y `./combinacion.js`).

type Alcance = "global" | "asignado";

function resolver(c: CasoEfectivo): Efectivo {
  return c.rolSistema !== null
    ? permisosEfectivos(c.rolSistema)
    : permisosEfectivos("propio", c.propio ?? undefined);
}

const enOrden = (s: Iterable<Permiso>): Permiso[] => {
  const t = new Set(s);
  return PERMISOS.filter((p) => t.has(p));
};

describe("integridad de CASOS_EFECTIVOS (tabla común TS/SQL)", () => {
  it("nombres únicos, permisos del catálogo, 5 de sistema y propios de ambos alcances", () => {
    const nombres = CASOS_EFECTIVOS.map((c) => c.nombre);
    expect(new Set(nombres).size).toBe(nombres.length);
    const catalogo = new Set<string>(PERMISOS);
    for (const c of CASOS_EFECTIVOS) for (const p of c.permisos) expect(catalogo.has(p)).toBe(true);
    for (const r of ROLES) expect(CASOS_EFECTIVOS.some((c) => c.rolSistema === r)).toBe(true);
    const propios = CASOS_EFECTIVOS.filter((c) => c.rolSistema === null);
    expect(propios.some((c) => c.alcance === "global")).toBe(true);
    expect(propios.some((c) => c.alcance === "asignado")).toBe(true);
    expect(propios.some((c) => c.permisos.length === 0)).toBe(true);
  });

  it("los casos de sistema coinciden con la matriz de 005 y los propios traen su definición", () => {
    for (const c of CASOS_EFECTIVOS) {
      if (c.rolSistema !== null) {
        expect(c.propio).toBeNull();
        expect(enOrden(c.permisos)).toEqual(enOrden(PERMISOS_POR_ROL[c.rolSistema]));
        expect(c.alcance).toBe(alcanceDe(c.rolSistema));
      } else {
        expect(c.propio).not.toBeNull();
        expect(c.propio?.alcance).toBe(c.alcance);
        expect(enOrden(c.propio?.permisos ?? [])).toEqual(enOrden(c.permisos));
      }
    }
  });

  it("ningún rol propio de la tabla lleva plan.gestionar y todos cumplen U3", () => {
    for (const c of CASOS_EFECTIVOS.filter((x) => x.rolSistema === null)) {
      expect(c.permisos).not.toContain("plan.gestionar");
      expect(validarCombinacion(c.permisos, c.alcance), c.nombre).toEqual({ ok: true });
    }
  });

  it("cada permiso asignable aparece solo con sus requisitos en algún caso propio (cada permiso sensible de U2/029 incluido)", () => {
    expect(PERMISOS_ASIGNABLES).toHaveLength(23);
    expect(new Set(PERMISOS_ASIGNABLES).size).toBe(23);
    for (const p of PERMISOS_ASIGNABLES) {
      const requisitos = REGLAS_U3.filter((r) => r.permiso === p).map((r) => r.requiere);
      const esperado = enOrden([p, ...requisitos]);
      const hay = CASOS_EFECTIVOS.some(
        (c) => c.rolSistema === null && c.alcance === "asignado" && JSON.stringify(enOrden(c.permisos)) === JSON.stringify(esperado),
      );
      expect(hay, p).toBe(true);
    }
    for (const sensible of ["usuarios.gestionar", "roles.gestionar", "credenciales.editar"] as const) {
      expect(CASOS_EFECTIVOS.some((c) => c.rolSistema === null && c.exigeFactor && c.permisos.includes(sensible))).toBe(true);
    }
  });

  it("cada una de las 23 reglas de U3 está presente (permiso + requisito) en algún caso", () => {
    expect(REGLAS_U3).toHaveLength(23);
    for (const r of REGLAS_U3) {
      expect(
        CASOS_EFECTIVOS.some((c) => c.permisos.includes(r.permiso) && c.permisos.includes(r.requiere)),
        `${r.permiso} + ${r.requiere}`,
      ).toBe(true);
    }
  });
});

describe("permisosEfectivos / alcanceEfectivo / puedeSerResponsable sobre CASOS_EFECTIVOS", () => {
  it.each(CASOS_EFECTIVOS.map((c) => [c.nombre, c] as const))("%s", (_n, c) => {
    const e = resolver(c);
    expect(e.rolSistema).toBe(c.rolSistema);
    expect(e.permisos).toBeInstanceOf(Set);
    expect(enOrden(e.permisos)).toEqual(enOrden(c.permisos));
    expect(e.permisos.size).toBe(new Set(c.permisos).size);
    expect(e.alcance).toBe(c.alcance);
    expect(alcanceEfectivo(e)).toBe(c.alcance);
    expect(puedeSerResponsable(e)).toBe(c.puedeSerResponsable);
    // CA-7: la misma regla TS de 029 sobre los permisos efectivos.
    expect(factorExigido({ plataforma: false, rolSistema: e.rolSistema, permisos: [...e.permisos] })).toBe(c.exigeFactor);
  });
});

describe("permisosEfectivos: rol de sistema", () => {
  it.each(ROLES.map((r) => [r] as const))("%s: conjunto = PERMISOS_POR_ROL y alcance = alcanceDe", (rol) => {
    const e = permisosEfectivos(rol);
    expect(e.rolSistema).toBe(rol);
    expect(enOrden(e.permisos)).toEqual(enOrden(PERMISOS_POR_ROL[rol]));
    expect(e.alcance).toBe(alcanceDe(rol));
  });

  it("ignora el parámetro propio cuando el rol es de sistema (un rol de sistema no se sobrescribe)", () => {
    const e = permisosEfectivos("lectura", { permisos: [...PERMISOS_ASIGNABLES], alcance: "global" });
    expect(e.rolSistema).toBe("lectura");
    expect(enOrden(e.permisos)).toEqual(enOrden(PERMISOS_POR_ROL.lectura));
    expect(e.alcance).toBe("asignado");
  });

  it("el Dueño lleva plan.gestionar y los demás no", () => {
    expect(permisosEfectivos("dueno").permisos.has("plan.gestionar")).toBe(true);
    for (const r of ["admin", "contador", "asistente", "lectura"] as const)
      expect(permisosEfectivos(r).permisos.has("plan.gestionar")).toBe(false);
  });

  it("modificar el resultado no altera la matriz de 005 ni llamadas posteriores", () => {
    const antes = enOrden(PERMISOS_POR_ROL.asistente);
    const e = permisosEfectivos("asistente");
    try {
      (e.permisos as Set<Permiso>).add("plan.gestionar");
    } catch {
      /* un conjunto congelado también es válido */
    }
    expect(enOrden(PERMISOS_POR_ROL.asistente)).toEqual(antes);
    expect(permisosEfectivos("asistente").permisos.has("plan.gestionar")).toBe(false);
  });
});

describe("permisosEfectivos: rol propio", () => {
  it("resuelve permisos y alcance guardados, con rolSistema null (U7: no es Dueño)", () => {
    const e = permisosEfectivos("propio", { permisos: ["clientes.ver", "buzon.ver"], alcance: "global" });
    expect(e).toEqual({
      rolSistema: null,
      permisos: new Set(["clientes.ver", "buzon.ver"]),
      alcance: "global",
    });
  });

  it("un rol propio vacío da un conjunto vacío", () => {
    const e = permisosEfectivos("propio", { permisos: [], alcance: "asignado" });
    expect(e.permisos.size).toBe(0);
    expect(e.alcance).toBe("asignado");
    expect(puedeSerResponsable(e)).toBe(false);
  });

  it("los duplicados se colapsan en el conjunto", () => {
    const e = permisosEfectivos("propio", { permisos: ["clientes.ver", "clientes.ver"], alcance: "asignado" });
    expect(e.permisos.size).toBe(1);
  });

  it("no comparte referencia con la entrada: mutar el arreglo original no cambia lo resuelto", () => {
    const permisos: Permiso[] = ["clientes.ver"];
    const e = permisosEfectivos("propio", { permisos, alcance: "asignado" });
    permisos.push("credenciales.editar");
    expect(e.permisos.has("credenciales.editar")).toBe(false);
    expect(e.permisos.size).toBe(1);
  });

  it("acepta una entrada congelada sin mutarla", () => {
    const permisos: readonly Permiso[] = Object.freeze(["clientes.ver", "sire.clasificar"] as Permiso[]);
    expect(() => permisosEfectivos("propio", { permisos, alcance: "asignado" })).not.toThrow();
    expect(permisos).toEqual(["clientes.ver", "sire.clasificar"]);
  });

  it("'propio' sin su definición lanza (nunca se resuelve a vacío en silencio)", () => {
    expect(() => permisosEfectivos("propio")).toThrow();
  });

  it("U7: ni con los 23 permisos asignables y alcance global un rol propio iguala al Dueño", () => {
    const e = permisosEfectivos("propio", { permisos: [...PERMISOS_ASIGNABLES], alcance: "global" });
    expect(e.rolSistema).toBeNull();
    expect(e.permisos.has("plan.gestionar")).toBe(false);
    expect(e.permisos.size).toBe(23);
    expect(e.permisos.size).toBeLessThan(permisosEfectivos("dueno").permisos.size);
  });

  it("dos resoluciones del mismo rol propio son independientes", () => {
    const def = { permisos: ["clientes.ver"] as Permiso[], alcance: "asignado" as Alcance };
    const a = permisosEfectivos("propio", def);
    const b = permisosEfectivos("propio", def);
    expect(a.permisos).not.toBe(b.permisos);
    expect(a).toEqual(b);
  });
});

describe("puedeSerResponsable (D18) con Efectivo y con Rol", () => {
  it.each([
    ["dueno", true],
    ["admin", true],
    ["contador", true],
    ["asistente", true],
    ["lectura", false],
  ] as const)("rol de sistema %s -> %s (llamada de 005 sigue válida)", (rol, esperado) => {
    expect(puedeSerResponsable(rol)).toBe(esperado);
    expect(puedeSerResponsable(permisosEfectivos(rol))).toBe(esperado);
  });

  it("un rol propio es responsable solo si tiene sire.clasificar (U6: quitarlo deja de serlo)", () => {
    const con = permisosEfectivos("propio", { permisos: ["clientes.ver", "sire.clasificar"], alcance: "asignado" });
    const sin = permisosEfectivos("propio", { permisos: ["clientes.ver", "sire.descargar"], alcance: "asignado" });
    expect(puedeSerResponsable(con)).toBe(true);
    expect(puedeSerResponsable(sin)).toBe(false);
  });

  it("el alcance no decide la responsabilidad", () => {
    for (const alcance of ["global", "asignado"] as const) {
      expect(puedeSerResponsable(permisosEfectivos("propio", { permisos: ["sire.clasificar"], alcance }))).toBe(true);
      expect(puedeSerResponsable(permisosEfectivos("propio", { permisos: [], alcance }))).toBe(false);
    }
  });
});

describe("alcanceEfectivo (D16 ampliada a roles propios)", () => {
  it("devuelve el alcance del rol: sistema por alcanceDe, propio el guardado", () => {
    for (const r of ROLES) expect(alcanceEfectivo(permisosEfectivos(r))).toBe(alcanceDe(r));
    expect(alcanceEfectivo(permisosEfectivos("propio", { permisos: [], alcance: "global" }))).toBe("global");
    expect(alcanceEfectivo(permisosEfectivos("propio", { permisos: [], alcance: "asignado" }))).toBe("asignado");
  });
});

describe("tabla por permiso (CA-4): efectivo de un rol que solo lo tiene vs uno sin él", () => {
  it.each(PERMISOS_ASIGNABLES.map((p) => [p] as const))("%s", (p) => {
    const requisitos = REGLAS_U3.filter((r) => r.permiso === p).map((r) => r.requiere);
    const solo = permisosEfectivos("propio", { permisos: [p, ...requisitos], alcance: "asignado" });
    const sin = permisosEfectivos("propio", {
      permisos: PERMISOS_ASIGNABLES.filter((x) => x !== p && !REGLAS_U3.some((r) => r.permiso === p && r.requiere === x)),
      alcance: "asignado",
    });
    expect(solo.permisos.has(p)).toBe(true);
    expect(sin.permisos.has(p)).toBe(false);
  });
});
