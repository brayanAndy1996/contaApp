import { describe, expect, it } from "vitest";
import {
  PERMISOS,
  PERMISOS_POR_ROL,
  puedeGestionar,
  ROLES,
  type Permiso,
  type Rol,
} from "./index.js";
import { cambiarRolSchema, invitarSchema } from "./esquemas.js";
import { permisosEfectivos, type Efectivo } from "./efectivos.js";
import { puedeGestionarRol } from "./roles.js";
import {
  crearRolSchema,
  editarRolSchema,
  rolAsignadoSchema,
} from "./roles-propios.js";
import { PERMISOS_ASIGNABLES } from "./efectivos.casos.js";
import { ACCIONES_AUDITORIA, accionAuditoriaSchema } from "../auditoria/index.js";

// Spec 030 · T2 (rojo). Contrato fijado por estas pruebas (plan 030, Contratos: Shared; spec U2, U4, D5, CA-1, CA-2, CA-5).
// T3 (HTTP), T4 (frontend) y T5 (E2E) reutilizan estos nombres y formas.
//
// Contrato — packages/shared/src/acceso/roles-propios.ts (T7; exportado por `acceso/index.ts`):
//   RolAsignado = Rol | { rolId: string(uuid) }; rolAsignadoSchema: z.object (descarta claves extra, p. ej. `tenantId`).
//     No acepta `'propio'` ni nada fuera de ROLES / {rolId}. El rol viaja en el campo `rol` de los cuerpos de 005:
//       invitarSchema      { correo, rol: RolAsignado }     POST  /invitaciones         → {"correo": "...", "rol": "admin"} | {"rol": {"rolId": "<uuid>"}}
//       cambiarRolSchema   { rol: RolAsignado }             PATCH /usuarios/:id/rol     → igual
//     (compatible con 005: las cadenas de rol de sistema siguen válidas).
//   crearRolSchema   { nombre: string 1..40 sin caracteres de control; alcance: 'global'|'asignado'; permisos: string[];
//                      baseRolId?: uuid }                                          (z.object: descarta claves extra)
//     `permisos` es una lista de cadenas: el catálogo, `plan.gestionar` y U3 los valida `validarCombinacion` (422 en la API),
//     no el esquema, para poder responder `permiso_invalido`/`combinacion_invalida` con código fijo.
//   editarRolSchema  = parcial de crearRolSchema: cada campo opcional, mismas reglas; `{}` es válido.
//
// Contrato — packages/shared/src/acceso/roles.ts (T7), `puedeGestionar` por conjuntos (D8 + U2/U4):
//   puedeGestionar(actor, actual, nuevo): cada argumento es `Rol | Efectivo` (todos de la misma clase) o null en los dos últimos.
//     Cierto si los permisos Y el alcance de `actual` y de `nuevo` están contenidos en los del actor (global ⊇ asignado).
//   puedeGestionarRol(actor: Efectivo, antes: Efectivo | null, despues: Efectivo | null, esPropioDelActor: boolean): boolean
//     antes = null → crear; despues = null → eliminar; ambos → editar. Falso si `esPropioDelActor`; si no, contención de
//     permisos y alcance de `antes` y de `despues` (U2: «antes y después»; U4: global solo con alcance global).
//     No evalúa `roles.gestionar` (U1 lo decide el guard).
//
// Contrato — packages/shared/src/auditoria/acciones.ts (T7): ACCIONES_AUDITORIA suma `rol.creado`, `rol.editado`, `rol.eliminado`
//   (61 + 3 = 64). AVISO para T7: acciones{,-026,-027,-028,-reglas}.spec.ts fijan hoy `toHaveLength(61)`; al sumar las tres se
//   actualizan a 64 (sin quitar aserciones; «quien rompe una suite existente la ajusta»).
// Rojas por el módulo ausente `./roles-propios.js` (y `./efectivos.js`) y por `puedeGestionarRol` inexistente en roles.ts.

const UUID = "7b9f0a52-3c1e-4d6a-9a43-5f0c2b7e8d11";
const CORREO = "nueva@estudio.pe";

type Alcance = "global" | "asignado";
const sis = (r: Rol): Efectivo => permisosEfectivos(r);
const propio = (permisos: readonly Permiso[], alcance: Alcance = "asignado"): Efectivo =>
  permisosEfectivos("propio", { permisos, alcance });

describe("rolAsignadoSchema (D5)", () => {
  it.each(ROLES.map((r) => [r] as const))("acepta el rol de sistema %s", (r) => {
    expect(rolAsignadoSchema.parse(r)).toBe(r);
  });

  it("acepta {rolId: uuid} y devuelve solo rolId", () => {
    expect(rolAsignadoSchema.parse({ rolId: UUID })).toEqual({ rolId: UUID });
  });

  it("descarta claves extra (CA-4: nada de tenantId por el cuerpo)", () => {
    expect(rolAsignadoSchema.parse({ rolId: UUID, tenantId: UUID, permisos: ["plan.gestionar"] })).toEqual({ rolId: UUID });
  });

  it.each([
    ["propio"],
    ["Dueno"],
    ["ADMIN"],
    ["admin "],
    [""],
    [{}],
    [{ rolId: "" }],
    [{ rolId: "no-es-uuid" }],
    [{ rolId: 123 }],
    [{ rolId: null }],
    [{ rolId: [UUID] }],
    [{ rol: "admin" }],
    [{ id: UUID }],
    [null],
    [undefined],
    [5],
    [true],
    [[]],
    [[UUID]],
  ])("rechaza %j", (v) => {
    expect(rolAsignadoSchema.safeParse(v).success).toBe(false);
  });
});

describe("invitarSchema y cambiarRolSchema con RolAsignado (compatibles con 005)", () => {
  it.each(ROLES.map((r) => [r] as const))("siguen aceptando el rol de sistema %s", (rol) => {
    expect(invitarSchema.parse({ correo: CORREO, rol })).toEqual({ correo: CORREO, rol });
    expect(cambiarRolSchema.parse({ rol })).toEqual({ rol });
  });

  it("aceptan un rol propio como {rol: {rolId}}", () => {
    expect(invitarSchema.parse({ correo: CORREO, rol: { rolId: UUID } })).toEqual({ correo: CORREO, rol: { rolId: UUID } });
    expect(cambiarRolSchema.parse({ rol: { rolId: UUID } })).toEqual({ rol: { rolId: UUID } });
  });

  it("descartan claves extra, también dentro del rol", () => {
    expect(invitarSchema.parse({ correo: CORREO, rol: { rolId: UUID, tenantId: UUID }, tenantId: UUID })).toEqual({
      correo: CORREO,
      rol: { rolId: UUID },
    });
    expect(cambiarRolSchema.parse({ rol: { rolId: UUID }, usuarioId: UUID })).toEqual({ rol: { rolId: UUID } });
  });

  it.each([["propio"], [{ rolId: "x" }], [{}], [null], [undefined], [{ rol: "admin" }], [""], [7]])(
    "rechazan el rol %j",
    (rol) => {
      expect(invitarSchema.safeParse({ correo: CORREO, rol }).success).toBe(false);
      expect(cambiarRolSchema.safeParse({ rol }).success).toBe(false);
    },
  );

  it("el rolId no se acepta al nivel superior del cuerpo (siempre dentro de `rol`)", () => {
    expect(invitarSchema.safeParse({ correo: CORREO, rolId: UUID }).success).toBe(false);
    expect(cambiarRolSchema.safeParse({ rolId: UUID }).success).toBe(false);
  });
});

describe("crearRolSchema (CA-1, CA-2)", () => {
  const base = { nombre: "Practicante", alcance: "asignado", permisos: ["clientes.ver"] } as const;

  it("acepta el cuerpo mínimo y devuelve lo mismo", () => {
    expect(crearRolSchema.parse(base)).toEqual(base);
  });

  it("acepta baseRolId uuid y permisos vacíos", () => {
    expect(crearRolSchema.parse({ ...base, baseRolId: UUID, permisos: [] })).toEqual({ ...base, baseRolId: UUID, permisos: [] });
  });

  it("descarta claves extra (tenantId, id, nombreClave)", () => {
    const r = crearRolSchema.parse({ ...base, tenantId: UUID, id: UUID, nombreClave: "x" });
    expect(r).toEqual(base);
  });

  it.each([
    ["Practicante"],
    ["Ñandú júnior"],
    ["A"],
    ["a".repeat(40)],
    ["Rol 2.0 (revisión)"],
    ["Contador / auditor"],
    ["😀 Emoji"],
  ])("acepta el nombre %j", (nombre) => {
    expect(crearRolSchema.safeParse({ ...base, nombre }).success).toBe(true);
  });

  it.each([
    [""],
    ["a".repeat(41)],
    ["a".repeat(500)],
    ["Con\nsalto"],
    ["Con\ttab"],
    ["Con\rretorno"],
    ["Nulo\u0000"],
    ["Esc\u001b[0m"],
    ["Del\u007f"],
    ["C1\u0085"],
    ["\u0080inicio"],
    [123],
    [null],
    [undefined],
    [["Practicante"]],
    [{ nombre: "x" }],
  ])("rechaza el nombre %j", (nombre) => {
    expect(crearRolSchema.safeParse({ ...base, nombre }).success).toBe(false);
  });

  it.each([["global"], ["asignado"]])("acepta el alcance %s", (alcance) => {
    expect(crearRolSchema.safeParse({ ...base, alcance }).success).toBe(true);
  });

  it.each([["GLOBAL"], ["todos"], [""], [null], [undefined], [1], [true]])("rechaza el alcance %j", (alcance) => {
    expect(crearRolSchema.safeParse({ ...base, alcance }).success).toBe(false);
  });

  it.each([["clientes.ver"], [null], [undefined], [{}], [[1]], [[null]], [[["clientes.ver"]]], [[{}]]])(
    "rechaza permisos que no son una lista de cadenas: %j",
    (permisos) => {
      expect(crearRolSchema.safeParse({ ...base, permisos }).success).toBe(false);
    },
  );

  it("deja pasar permisos fuera del catálogo o plan.gestionar: los rechaza validarCombinacion (422 con código)", () => {
    expect(crearRolSchema.safeParse({ ...base, permisos: ["plan.gestionar"] }).success).toBe(true);
    expect(crearRolSchema.safeParse({ ...base, permisos: ["root.todo"] }).success).toBe(true);
  });

  it.each([["no-es-uuid"], [""], [123], [null], [{}], [["x"]]])("rechaza baseRolId %j", (baseRolId) => {
    expect(crearRolSchema.safeParse({ ...base, baseRolId }).success).toBe(false);
  });

  it.each(["nombre", "alcance", "permisos"] as const)("rechaza el cuerpo sin %s", (campo) => {
    const { [campo]: _omitido, ...resto } = base;
    void _omitido;
    expect(crearRolSchema.safeParse(resto).success).toBe(false);
  });

  it("rechaza lo que no es un objeto", () => {
    for (const v of [null, undefined, "x", 1, [], true]) expect(crearRolSchema.safeParse(v).success).toBe(false);
  });
});

describe("editarRolSchema (parcial de crearRolSchema)", () => {
  it("acepta el cuerpo vacío y cada campo por separado", () => {
    expect(editarRolSchema.parse({})).toEqual({});
    expect(editarRolSchema.parse({ nombre: "Nuevo" })).toEqual({ nombre: "Nuevo" });
    expect(editarRolSchema.parse({ alcance: "global" })).toEqual({ alcance: "global" });
    expect(editarRolSchema.parse({ permisos: ["clientes.ver", "buzon.ver"] })).toEqual({
      permisos: ["clientes.ver", "buzon.ver"],
    });
    expect(editarRolSchema.parse({ permisos: [] })).toEqual({ permisos: [] });
  });

  it("acepta todos los campos juntos y descarta claves extra", () => {
    const cuerpo = { nombre: "Otro", alcance: "asignado", permisos: ["clientes.ver"] } as const;
    expect(editarRolSchema.parse({ ...cuerpo, tenantId: UUID, id: UUID })).toEqual(cuerpo);
  });

  it("aplica las mismas reglas de cada campo cuando viene", () => {
    for (const nombre of ["", "a".repeat(41), "x\ny", "x\u0000", 5, null])
      expect(editarRolSchema.safeParse({ nombre }).success, String(nombre)).toBe(false);
    expect(editarRolSchema.safeParse({ nombre: "a".repeat(40) }).success).toBe(true);
    for (const alcance of ["todos", "GLOBAL", null, 1])
      expect(editarRolSchema.safeParse({ alcance }).success, String(alcance)).toBe(false);
    for (const permisos of ["clientes.ver", null, [1], [null], {}])
      expect(editarRolSchema.safeParse({ permisos }).success, JSON.stringify(permisos)).toBe(false);
  });

  it("rechaza lo que no es un objeto", () => {
    for (const v of [null, undefined, "x", 1, [], true]) expect(editarRolSchema.safeParse(v).success).toBe(false);
  });
});

describe("acciones de auditoría de 030 (CA-1, auditoría antes/después)", () => {
  const NUEVAS = ["rol.creado", "rol.editado", "rol.eliminado"];

  it("ACCIONES_AUDITORIA incluye las tres y accionAuditoriaSchema las acepta", () => {
    for (const a of NUEVAS) {
      expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
      expect(accionAuditoriaSchema.safeParse(a).success).toBe(true);
    }
  });

  it("son las únicas con prefijo rol., con forma entidad.hecho y sin repetidos", () => {
    expect(ACCIONES_AUDITORIA.filter((a) => a.startsWith("rol."))).toEqual(NUEVAS);
    expect(new Set(ACCIONES_AUDITORIA).size).toBe(ACCIONES_AUDITORIA.length);
    for (const a of ACCIONES_AUDITORIA) expect(a).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it.each([["rol.asignado"], ["rol.creada"], ["rol."], ["Rol.creado"], ["rol.creado "], ["rol.eliminados"], ["roles.creado"]])(
    "accionAuditoriaSchema rechaza %j",
    (a) => {
      expect(accionAuditoriaSchema.safeParse(a).success).toBe(false);
    },
  );

  it("las acciones previas de 005 y 029 siguen: miembro.rol_cambiado, invitacion.creada, miembro.alta", () => {
    for (const a of ["miembro.rol_cambiado", "invitacion.creada", "miembro.alta", "sesion.ingreso"])
      expect(accionAuditoriaSchema.safeParse(a).success).toBe(true);
  });
});

describe("puedeGestionar por conjuntos (D8 + U2): roles de sistema como Efectivo", () => {
  const RANGO: Record<Rol, number> = { dueno: 4, admin: 3, contador: 2, asistente: 1, lectura: 0 };
  const dentro = (actor: Rol, r: Rol | null): boolean => r === null || RANGO[r] <= RANGO[actor];

  it("coincide con la regla de rango de 005 para todo actor × actual × nuevo, con Rol y con Efectivo", () => {
    for (const actor of ROLES)
      for (const actual of [...ROLES, null] as const)
        for (const nuevo of [...ROLES, null] as const) {
          const esperado = dentro(actor, actual) && dentro(actor, nuevo);
          expect(puedeGestionar(actor, actual, nuevo), `Rol ${actor} ${actual} ${nuevo}`).toBe(esperado);
          expect(
            puedeGestionar(sis(actor), actual === null ? null : sis(actual), nuevo === null ? null : sis(nuevo)),
            `Efectivo ${actor} ${actual} ${nuevo}`,
          ).toBe(esperado);
        }
  });

  it("el Administrador no toca ni crea un Dueño (plan.gestionar), con Efectivo", () => {
    expect(puedeGestionar(sis("admin"), sis("dueno"), null)).toBe(false);
    expect(puedeGestionar(sis("admin"), null, sis("dueno"))).toBe(false);
    expect(puedeGestionar(sis("admin"), sis("admin"), sis("contador"))).toBe(true);
  });
});

describe("puedeGestionar por conjuntos: roles propios", () => {
  const A = ["clientes.ver", "buzon.ver", "buzon.atender", "reglas.ver"] as const;

  it("contención de permisos: un subconjunto del actor sí, uno con un permiso de más no", () => {
    const actor = propio(A);
    expect(puedeGestionar(actor, null, propio(["clientes.ver"]))).toBe(true);
    expect(puedeGestionar(actor, propio(["clientes.ver", "buzon.ver"]), propio(["buzon.ver", "buzon.atender", "clientes.ver"]))).toBe(true);
    expect(puedeGestionar(actor, null, propio([...A, "prorrata.ver"]))).toBe(false);
    expect(puedeGestionar(actor, propio([...A, "prorrata.ver"]), propio(["clientes.ver"]))).toBe(false);
  });

  it("conjuntos incomparables: compartir permisos no basta", () => {
    const actor = propio(["clientes.ver", "buzon.ver", "reglas.ver"]);
    const otro = propio(["clientes.ver", "buzon.ver", "prorrata.ver"]);
    expect(puedeGestionar(actor, otro, null)).toBe(false);
    expect(puedeGestionar(otro, actor, null)).toBe(false);
    expect(puedeGestionar(actor, null, otro)).toBe(false);
  });

  it("alcance: global ⊇ asignado (U4); uno asignado no toca ni crea uno global aunque tenga todos los permisos", () => {
    const actAsig = propio(A, "asignado");
    const actGlob = propio(A, "global");
    const objAsig = propio(["clientes.ver"], "asignado");
    const objGlob = propio(["clientes.ver"], "global");
    expect(puedeGestionar(actAsig, objAsig, objAsig)).toBe(true);
    expect(puedeGestionar(actAsig, objGlob, null)).toBe(false);
    expect(puedeGestionar(actAsig, null, objGlob)).toBe(false);
    expect(puedeGestionar(actAsig, objAsig, objGlob)).toBe(false);
    expect(puedeGestionar(actGlob, objAsig, objGlob)).toBe(true);
    expect(puedeGestionar(actGlob, objGlob, objGlob)).toBe(true);
  });

  it("un propio con los 23 permisos y alcance global gestiona al Administrador pero nunca a un Dueño (U7)", () => {
    const casiDueno = propio(PERMISOS_ASIGNABLES, "global");
    expect(puedeGestionar(casiDueno, sis("admin"), sis("admin"))).toBe(true);
    expect(puedeGestionar(casiDueno, sis("dueno"), null)).toBe(false);
    expect(puedeGestionar(casiDueno, null, sis("dueno"))).toBe(false);
  });

  it("un propio idéntico a Contador (asignado) gestiona a Contador, Asistente y Lectura, no a Administrador", () => {
    const comoContador = propio([...PERMISOS_POR_ROL.contador], "asignado");
    for (const r of ["contador", "asistente", "lectura"] as const) expect(puedeGestionar(comoContador, sis(r), sis(r))).toBe(true);
    expect(puedeGestionar(comoContador, sis("admin"), null)).toBe(false);
    expect(puedeGestionar(comoContador, null, sis("admin"))).toBe(false);
  });

  it("un propio de solo lectura de clientes no gestiona roles de sistema salvo los contenidos (Lectura no, tiene más)", () => {
    const minimo = propio(["clientes.ver"], "asignado");
    expect(puedeGestionar(minimo, sis("lectura"), null)).toBe(false);
    expect(puedeGestionar(minimo, null, propio([], "asignado"))).toBe(true);
  });

  it("el Dueño gestiona cualquier rol propio, global o asignado", () => {
    for (const alcance of ["global", "asignado"] as const) {
      const p = propio(PERMISOS_ASIGNABLES, alcance);
      expect(puedeGestionar(sis("dueno"), p, p)).toBe(true);
      expect(puedeGestionar(sis("dueno"), null, p)).toBe(true);
    }
  });

  it("no muta los Efectivo recibidos", () => {
    const actor = propio(A);
    const obj = propio(["clientes.ver"]);
    puedeGestionar(actor, obj, obj);
    expect([...actor.permisos]).toEqual([...A]);
    expect([...obj.permisos]).toEqual(["clientes.ver"]);
  });

  it("barrido seudoaleatorio contra un oráculo de contención (permisos y alcance)", () => {
    let semilla = 0x1234abcd;
    const azar = (): number => {
      semilla ^= semilla << 13;
      semilla ^= semilla >>> 17;
      semilla ^= semilla << 5;
      return (semilla >>> 0) / 0x100000000;
    };
    const sub = (d: number): Permiso[] => PERMISOS_ASIGNABLES.filter(() => azar() < d);
    const alc = (): Alcance => (azar() < 0.5 ? "global" : "asignado");
    const contenido = (a: Efectivo, o: Efectivo | null): boolean =>
      o === null || ([...o.permisos].every((p) => a.permisos.has(p)) && (o.alcance === "asignado" || a.alcance === "global"));
    let ciertos = 0;
    for (let i = 0; i < 1500; i++) {
      const actor = propio(sub(0.4 + azar() * 0.6), alc());
      const actual = azar() < 0.15 ? null : propio(sub(azar() * 0.6), alc());
      const nuevo = azar() < 0.15 ? null : propio(sub(azar() * 0.6), alc());
      const esperado = contenido(actor, actual) && contenido(actor, nuevo);
      if (esperado) ciertos++;
      expect(puedeGestionar(actor, actual, nuevo)).toBe(esperado);
      const esMio = azar() < 0.2;
      expect(puedeGestionarRol(actor, actual, nuevo, esMio)).toBe(!esMio && esperado);
    }
    expect(ciertos).toBeGreaterThan(100);
    expect(ciertos).toBeLessThan(1400);
  });
});

describe("puedeGestionarRol (U2, U4, CA-5)", () => {
  const actor = propio(["usuarios.ver", "roles.gestionar", "clientes.ver", "buzon.ver", "reglas.ver"], "asignado");
  const dentroDelActor = propio(["clientes.ver", "buzon.ver"], "asignado");
  const conDeMas = propio(["clientes.ver", "buzon.ver", "prorrata.ver"], "asignado");

  it("crear (antes null): contenido sí; con un permiso de más (escalada) no", () => {
    expect(puedeGestionarRol(actor, null, dentroDelActor, false)).toBe(true);
    expect(puedeGestionarRol(actor, null, conDeMas, false)).toBe(false);
  });

  it("crear un rol global con actor de alcance asignado: no (U4); con actor global: sí", () => {
    const global = propio(["clientes.ver"], "global");
    expect(puedeGestionarRol(actor, null, global, false)).toBe(false);
    expect(puedeGestionarRol(propio(["clientes.ver"], "global"), null, global, false)).toBe(true);
  });

  it("editar exige contención ANTES y DESPUÉS", () => {
    // Antes y después dentro del actor.
    expect(puedeGestionarRol(actor, dentroDelActor, propio(["clientes.ver"]), false)).toBe(true);
    // Antes dentro, después escala: no.
    expect(puedeGestionarRol(actor, dentroDelActor, conDeMas, false)).toBe(false);
    // Antes fuera (rol más poderoso que el actor), después dentro (degradarlo): no.
    expect(puedeGestionarRol(actor, conDeMas, dentroDelActor, false)).toBe(false);
    // Ambos fuera: no.
    expect(puedeGestionarRol(actor, conDeMas, conDeMas, false)).toBe(false);
  });

  it("editar solo el alcance: asignado → global con actor asignado no; con actor global sí", () => {
    const antes = propio(["clientes.ver"], "asignado");
    const despues = propio(["clientes.ver"], "global");
    expect(puedeGestionarRol(actor, antes, despues, false)).toBe(false);
    expect(puedeGestionarRol(actor, despues, antes, false)).toBe(false);
    const actorGlobal = propio(["clientes.ver", "roles.gestionar", "usuarios.ver"], "global");
    expect(puedeGestionarRol(actorGlobal, antes, despues, false)).toBe(true);
    expect(puedeGestionarRol(actorGlobal, despues, antes, false)).toBe(true);
  });

  it("eliminar (después null): solo si el rol (antes) está contenido", () => {
    expect(puedeGestionarRol(actor, dentroDelActor, null, false)).toBe(true);
    expect(puedeGestionarRol(actor, conDeMas, null, false)).toBe(false);
    expect(puedeGestionarRol(actor, propio(["clientes.ver"], "global"), null, false)).toBe(false);
  });

  it("nadie crea, edita ni elimina el rol que tiene asignado (U2), ni siquiera estando contenido", () => {
    expect(puedeGestionarRol(actor, dentroDelActor, dentroDelActor, true)).toBe(false);
    expect(puedeGestionarRol(actor, dentroDelActor, null, true)).toBe(false);
    expect(puedeGestionarRol(actor, null, dentroDelActor, true)).toBe(false);
    expect(puedeGestionarRol(sis("dueno"), propio(["clientes.ver"]), propio(["clientes.ver"]), true)).toBe(false);
  });

  it("el Dueño gestiona cualquier rol propio que no sea el suyo", () => {
    const p = propio(PERMISOS_ASIGNABLES, "global");
    expect(puedeGestionarRol(sis("dueno"), null, p, false)).toBe(true);
    expect(puedeGestionarRol(sis("dueno"), p, p, false)).toBe(true);
    expect(puedeGestionarRol(sis("dueno"), p, null, false)).toBe(true);
  });

  it("el Administrador (23 permisos, global) gestiona cualquier rol propio posible, nunca uno con plan.gestionar", () => {
    const todos = propio(PERMISOS_ASIGNABLES, "global");
    expect(puedeGestionarRol(sis("admin"), null, todos, false)).toBe(true);
    expect(puedeGestionarRol(sis("admin"), todos, todos, false)).toBe(true);
    // Un Efectivo con plan.gestionar (imposible como rol propio, pero el actor no lo tiene): contención lo rechaza.
    const conPlan = permisosEfectivos("propio", { permisos: [...PERMISOS], alcance: "global" });
    expect(puedeGestionarRol(sis("admin"), null, conPlan, false)).toBe(false);
  });

  it("un actor de rol de sistema con alcance asignado (Contador) no crea roles globales ni con permisos que no tiene", () => {
    const c = sis("contador");
    expect(puedeGestionarRol(c, null, propio(["clientes.ver"], "asignado"), false)).toBe(true);
    expect(puedeGestionarRol(c, null, propio(["clientes.ver"], "global"), false)).toBe(false);
    expect(puedeGestionarRol(c, null, propio(["usuarios.ver"], "asignado"), false)).toBe(false);
  });

  it("un rol vacío lo gestiona cualquiera que no sea su dueño de asignación, con el alcance que alcance", () => {
    expect(puedeGestionarRol(propio([], "asignado"), null, propio([], "asignado"), false)).toBe(true);
    expect(puedeGestionarRol(propio([], "asignado"), null, propio([], "global"), false)).toBe(false);
  });

  it("no muta los Efectivo", () => {
    const a = propio(["clientes.ver"]);
    const antes = propio(["clientes.ver"]);
    puedeGestionarRol(a, antes, null, false);
    expect([...a.permisos]).toEqual(["clientes.ver"]);
    expect([...antes.permisos]).toEqual(["clientes.ver"]);
  });
});
