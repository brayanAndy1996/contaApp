import { describe, expect, it } from "vitest";
import { PERMISOS, ROLES, PERMISOS_POR_ROL, type Permiso } from "./index.js";
import { validarCombinacion } from "./combinacion.js";
import { PERMISOS_ASIGNABLES, REGLAS_U3 } from "./efectivos.casos.js";
import { CASOS_FACTOR_EXIGIDO } from "../auth/factor-exigido.casos.js";

// Spec 030 · T2 (rojo). Contrato fijado por estas pruebas (plan 030, Contratos: Shared; spec U3, CA-2).
//
// Contrato — packages/shared/src/acceso/combinacion.ts (T7):
//   validarCombinacion(permisos: readonly string[], alcance: 'global' | 'asignado')
//     → { ok: true }
//     | { ok: false; error: 'permiso_invalido' | 'combinacion_invalida'; permiso: string }
//   - `permiso_invalido`: algún permiso no está en el catálogo de 01 §4 o es `plan.gestionar` (CA-2). `permiso` = el inválido
//     (el primero en el orden recibido). Tiene prioridad sobre `combinacion_invalida`.
//   - `combinacion_invalida` (U3): falta un requisito; `permiso` = el requisito FALTANTE (CA-2: «422 que nombra el permiso
//     faltante»). Si faltan varios, el primero en el orden del catálogo `PERMISOS`. Nunca se completa solo (no devuelve permisos).
//   - La lista vacía es válida. Duplicados no son error. El alcance no cambia el resultado. No muta la entrada.
//   - El Dueño guardado como rol propio no es posible (lleva `plan.gestionar`); los otros 4 roles de sistema y el Dueño SIN
//     `plan.gestionar` cumplen U3 (la regla «todo rol de sistema pasa» se prueba así).
// Datos comunes (efectivos.casos.ts, T2): REGLAS_U3 (23 pares), PERMISOS_ASIGNABLES (23).
// Estas pruebas deben ser rojas por el módulo ausente `./combinacion.js` (y `./efectivos.casos.js` existe ya).

const ORDEN = new Map<string, number>(PERMISOS.map((p, i) => [p, i]));

function requisitosDe(p: Permiso): Permiso[] {
  return REGLAS_U3.filter((r) => r.permiso === p).map((r) => r.requiere);
}

/** Oráculo independiente: ¿qué permisos faltan para que el conjunto cumpla U3? */
function faltantes(permisos: readonly Permiso[]): Permiso[] {
  const tiene = new Set<Permiso>(permisos);
  const f = new Set<Permiso>();
  for (const r of REGLAS_U3)
    if (tiene.has(r.permiso) && !tiene.has(r.requiere)) f.add(r.requiere);
  return [...f].sort((a, b) => (ORDEN.get(a) ?? 0) - (ORDEN.get(b) ?? 0));
}

describe("las 23 reglas de U3 (tabla REGLAS_U3)", () => {
  it("son 23 pares distintos: 6 de módulo y 17 de clientes.ver", () => {
    expect(REGLAS_U3).toHaveLength(23);
    expect(new Set(REGLAS_U3.map((r) => `${r.permiso}>${r.requiere}`)).size).toBe(23);
    expect(REGLAS_U3.filter((r) => r.requiere === "clientes.ver")).toHaveLength(17);
    expect(REGLAS_U3.filter((r) => r.requiere !== "clientes.ver")).toHaveLength(6);
  });

  it.each(REGLAS_U3.map((r) => [`${r.permiso} sin ${r.requiere}`, r] as const))(
    "%s: combinacion_invalida y nombra el faltante",
    (_n, r) => {
      // El permiso con TODOS sus requisitos menos este: falta exactamente uno.
      const permisos = [r.permiso, ...requisitosDe(r.permiso).filter((x) => x !== r.requiere)];
      expect(validarCombinacion(permisos, "asignado")).toEqual({
        ok: false,
        error: "combinacion_invalida",
        permiso: r.requiere,
      });
      expect(validarCombinacion(permisos, "global")).toEqual({
        ok: false,
        error: "combinacion_invalida",
        permiso: r.requiere,
      });
    },
  );

  it.each(REGLAS_U3.map((r) => [`${r.permiso} con ${r.requiere}`, r] as const))(
    "%s: válido con todos sus requisitos",
    (_n, r) => {
      const permisos = [r.permiso, ...requisitosDe(r.permiso)];
      expect(validarCombinacion(permisos, "asignado")).toEqual({ ok: true });
    },
  );

  it("si faltan varios requisitos nombra el primero del catálogo y nunca completa solo", () => {
    // buzon.atender exige buzon.ver y clientes.ver; en el catálogo clientes.ver va antes.
    const r = validarCombinacion(["buzon.atender"], "asignado");
    expect(r).toEqual({ ok: false, error: "combinacion_invalida", permiso: "clientes.ver" });
    // La salida solo trae ok/error/permiso: no devuelve una lista «corregida».
    expect(Object.keys(r).sort()).toEqual(["error", "ok", "permiso"]);
    const r2 = validarCombinacion(["roles.gestionar", "usuarios.gestionar"], "global");
    expect(r2).toEqual({ ok: false, error: "combinacion_invalida", permiso: "usuarios.ver" });
  });

  it("agregar el primer faltante y reintentar nombra el siguiente hasta ser válido", () => {
    const permisos: string[] = ["prorrata.gestionar"];
    const vistos: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = validarCombinacion(permisos, "asignado");
      if (r.ok) break;
      expect(r.error).toBe("combinacion_invalida");
      vistos.push(r.permiso);
      permisos.push(r.permiso);
    }
    expect(vistos).toEqual(["clientes.ver", "prorrata.ver"]);
    expect(validarCombinacion(permisos, "asignado")).toEqual({ ok: true });
  });
});

describe("permisos sin requisitos y casos límite", () => {
  it.each(["estudio.configurar", "usuarios.ver", "clientes.ver", "auditoria.ver"] as const)(
    "%s solo es válido",
    (p) => {
      expect(validarCombinacion([p], "asignado")).toEqual({ ok: true });
      expect(validarCombinacion([p], "global")).toEqual({ ok: true });
    },
  );

  it("la lista vacía es válida en ambos alcances", () => {
    expect(validarCombinacion([], "asignado")).toEqual({ ok: true });
    expect(validarCombinacion([], "global")).toEqual({ ok: true });
  });

  it("los 23 asignables juntos son válidos", () => {
    expect(validarCombinacion(PERMISOS_ASIGNABLES, "global")).toEqual({ ok: true });
    expect(validarCombinacion(PERMISOS_ASIGNABLES, "asignado")).toEqual({ ok: true });
  });

  it("los duplicados no son error ni cambian el resultado", () => {
    expect(validarCombinacion(["clientes.ver", "clientes.ver", "buzon.ver", "buzon.ver"], "asignado")).toEqual({ ok: true });
    expect(validarCombinacion(["buzon.ver", "buzon.ver"], "asignado")).toEqual({
      ok: false,
      error: "combinacion_invalida",
      permiso: "clientes.ver",
    });
  });

  it("el orden de la entrada no cambia el resultado válido", () => {
    const a = validarCombinacion(["buzon.atender", "buzon.ver", "clientes.ver"], "asignado");
    const b = validarCombinacion(["clientes.ver", "buzon.ver", "buzon.atender"], "asignado");
    expect(a).toEqual({ ok: true });
    expect(b).toEqual(a);
  });

  it("no muta la entrada (también si está congelada)", () => {
    const entrada: readonly string[] = Object.freeze(["buzon.atender", "clientes.ver"]);
    expect(() => validarCombinacion(entrada, "asignado")).not.toThrow();
    expect(entrada).toEqual(["buzon.atender", "clientes.ver"]);
  });
});

describe("permiso_invalido (CA-2)", () => {
  it("plan.gestionar nunca es válido en un rol propio, solo ni acompañado", () => {
    expect(validarCombinacion(["plan.gestionar"], "global")).toEqual({
      ok: false,
      error: "permiso_invalido",
      permiso: "plan.gestionar",
    });
    expect(validarCombinacion(["clientes.ver", "plan.gestionar"], "asignado")).toEqual({
      ok: false,
      error: "permiso_invalido",
      permiso: "plan.gestionar",
    });
  });

  it.each([
    ["root.admin"],
    ["Clientes.ver"],
    ["clientes.ver "],
    [" clientes.ver"],
    ["clientes.ver\n"],
    ["clientes"],
    ["clientes."],
    ["*"],
    [""],
    ["clientes.ver;DROP TABLE rol"],
    ["__proto__"],
    ["constructor"],
    ["toString"],
  ])("rechaza %j como fuera del catálogo", (p) => {
    expect(validarCombinacion([p], "asignado")).toEqual({
      ok: false,
      error: "permiso_invalido",
      permiso: p,
    });
  });

  it("permiso_invalido tiene prioridad sobre combinacion_invalida y nombra el inválido", () => {
    // buzon.atender sin buzon.ver sería combinación inválida, pero plan.gestionar manda.
    expect(validarCombinacion(["buzon.atender", "plan.gestionar"], "asignado")).toEqual({
      ok: false,
      error: "permiso_invalido",
      permiso: "plan.gestionar",
    });
    expect(validarCombinacion(["buzon.atender", "inexistente.x"], "asignado")).toEqual({
      ok: false,
      error: "permiso_invalido",
      permiso: "inexistente.x",
    });
  });

  it("con varios inválidos nombra el primero recibido", () => {
    expect(validarCombinacion(["clientes.ver", "zzz.uno", "plan.gestionar"], "asignado")).toEqual({
      ok: false,
      error: "permiso_invalido",
      permiso: "zzz.uno",
    });
  });
});

describe("roles de sistema frente a U3", () => {
  it.each(["admin", "contador", "asistente", "lectura"] as const)("%s cumple U3 tal cual", (rol) => {
    expect(validarCombinacion([...PERMISOS_POR_ROL[rol]], "asignado")).toEqual({ ok: true });
  });

  it("el Dueño cumple U3 una vez quitado plan.gestionar, y con él es permiso_invalido", () => {
    const dueno = [...PERMISOS_POR_ROL.dueno];
    expect(dueno).toHaveLength(24);
    expect(validarCombinacion(dueno, "global")).toEqual({
      ok: false,
      error: "permiso_invalido",
      permiso: "plan.gestionar",
    });
    expect(validarCombinacion(dueno.filter((p) => p !== "plan.gestionar"), "global")).toEqual({ ok: true });
  });

  it("los cinco roles de sistema están cubiertos", () => {
    expect([...ROLES]).toHaveLength(5);
  });
});

describe("filas guardables de CASOS_FACTOR_EXIGIDO", () => {
  const guardables = CASOS_FACTOR_EXIGIDO.filter((c) => c.guardable);
  it("hay filas guardables (030) con y sin factor", () => {
    expect(guardables.length).toBeGreaterThanOrEqual(8);
    expect(guardables.some((c) => c.exigido)).toBe(true);
    expect(guardables.some((c) => !c.exigido)).toBe(true);
    expect(guardables.every((c) => c.rolSistema === null && !c.plataforma)).toBe(true);
  });
  it.each(guardables.map((c) => [c.nombre, c] as const))("%s cumple validarCombinacion", (_n, c) => {
    expect(validarCombinacion(c.permisos, "asignado")).toEqual({ ok: true });
  });
});

describe("barrido seudoaleatorio contra un oráculo independiente (2^23 combinaciones, 4000 muestras)", () => {
  it("validarCombinacion coincide con el oráculo en subconjuntos al azar", () => {
    let semilla = 0x9e3779b9;
    const azar = (): number => {
      // xorshift32 determinista.
      semilla ^= semilla << 13;
      semilla ^= semilla >>> 17;
      semilla ^= semilla << 5;
      return (semilla >>> 0) / 0x100000000;
    };
    let validos = 0;
    for (let i = 0; i < 4000; i++) {
      const densidad = azar();
      const sub = PERMISOS_ASIGNABLES.filter(() => azar() < densidad);
      const falta = faltantes(sub);
      const r = validarCombinacion(sub, azar() < 0.5 ? "global" : "asignado");
      if (falta.length === 0) {
        validos++;
        expect(r, sub.join(",")).toEqual({ ok: true });
      } else {
        expect(r, sub.join(",")).toEqual({
          ok: false,
          error: "combinacion_invalida",
          permiso: falta[0],
        });
      }
    }
    // El barrido ejercita ambos lados (no es trivial).
    expect(validos).toBeGreaterThan(200);
    expect(validos).toBeLessThan(3800);
  });
});
