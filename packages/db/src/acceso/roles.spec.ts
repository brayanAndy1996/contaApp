// Spec 030 (T1, rojo hasta que T6 cree `roles.ts`): contrato del repositorio de roles propios SIN BD (tx falsa), mismo patron que
// `repositorios.spec.ts` (005): SQL estatico y parametrizado, errores de pg -> AccesoRepoError con solo el SQLSTATE (CA-14), cero filas, mapeo de filas
// y los cambios de `miembros.ts` / `invitaciones.ts` para `rol = 'propio'` + `rol_id`. El comportamiento contra la BD real (RLS, escalada, carreras)
// esta en tests/aislamiento/roles-*.spec.ts.
// Archivos que cubre (>= 90 % de lineas y ramas por archivo, T14 solo mide): packages/db/src/acceso/roles.ts (nuevo) y, de los modificados,
// miembros.ts e invitaciones.ts.
//
// Contrato (firmas, todas con la `tx` de withTenant como primer argumento):
//   listarRoles(tx) -> [{ id, nombre, alcance, permisos: string[] (ordenados), miembros: number, invitaciones: number }]   (solo propios; los de sistema viven en codigo)
//   leerRol(tx, id) -> { id, nombre, alcance, permisos } | null
//   guardarRol(tx, { id?, nombre, alcance, permisos }) -> id   (`select acceso.rol_guardar($1::uuid, $2, $3, $4::text[])`; sin id crea)
//   eliminarRol(tx, id) -> void   (`select acceso.rol_eliminar($1::uuid)`)
//   usoRol(tx, id) -> { miembros, invitaciones }   (conteos del 409 rol_en_uso: miembros activos e invitaciones vigentes)
//   impactoRol(tx, id, { alcance, permisos }) -> { miembros, clientesSinResponsable, miembrosSinTotpExigidos }   (`acceso.rol_impacto`)
//   miembroActual(tx, usuarioId) -> { usuarioId, rol: RolMiembro | 'propio', rolId: string | null, propio: { permisos, alcance } | null }
//       (misma consulta: join a rol / rol_permiso con array_agg; columnas usuario_id, rol, rol_id, permisos, alcance)
//   listarMiembros(tx) -> items con `rolId` y `rolNombre` (null para roles de sistema); NO filtra a los de 'propio'
//   cambiarRol(tx, usuarioId, rol | 'propio', responsableAColaborador?, rolId?) ; crearInvitacion(tx, { ..., rol | 'propio', rolId? })
//   listarInvitaciones(tx) -> items con `rolId` y `rolNombre`
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AccesoRepoError } from "./errores";
import { crearInvitacion, listarInvitaciones } from "./invitaciones";
import { cambiarRol, listarMiembros, miembroActual, ROLES_MIEMBRO } from "./miembros";
import { eliminarRol, guardarRol, impactoRol, leerRol, listarRoles, usoRol } from "./roles";

type TxFalsa = Parameters<typeof miembroActual>[0];

const U1 = "01920000-0000-7000-8000-00000000d0a1";
const R1 = "01920000-0000-7000-8000-00000000d1a1";
const H1 = Buffer.alloc(32, 7);
const CORREO = "canario.roles@ejemplo.test";

interface Caso {
  nombre: string;
  llamar: (tx: TxFalsa) => Promise<unknown>;
  /** Entradas que deben viajar como parametro (los arreglos se aplanan) y nunca dentro del texto SQL. */
  entradas: unknown[];
}
const DATOS = { nombre: "Practicante CANARIO", alcance: "asignado" as const, permisos: ["clientes.ver", "buzon.ver"] };
const casos: Caso[] = [
  { nombre: "listarRoles", llamar: (tx) => listarRoles(tx), entradas: [] },
  { nombre: "leerRol", llamar: (tx) => leerRol(tx, R1), entradas: [R1] },
  { nombre: "guardarRol (crear)", llamar: (tx) => guardarRol(tx, DATOS), entradas: ["Practicante CANARIO", "asignado", "clientes.ver", "buzon.ver"] },
  { nombre: "guardarRol (editar)", llamar: (tx) => guardarRol(tx, { ...DATOS, id: R1 }), entradas: [R1, "Practicante CANARIO", "clientes.ver"] },
  { nombre: "eliminarRol", llamar: (tx) => eliminarRol(tx, R1), entradas: [R1] },
  { nombre: "usoRol", llamar: (tx) => usoRol(tx, R1), entradas: [R1] },
  { nombre: "impactoRol", llamar: (tx) => impactoRol(tx, R1, { alcance: "global", permisos: ["clientes.ver"] }), entradas: [R1, "global", "clientes.ver"] },
  { nombre: "miembroActual", llamar: (tx) => miembroActual(tx, U1), entradas: [U1] },
  { nombre: "cambiarRol a un propio", llamar: (tx) => cambiarRol(tx, U1, "propio", false, R1), entradas: [U1, R1] },
  {
    nombre: "crearInvitacion con rol propio",
    llamar: (tx) => crearInvitacion(tx, { correo: CORREO, rol: "propio", rolId: R1, invitadoPor: U1, tokenHash: H1 }),
    entradas: [CORREO, R1, U1, H1],
  },
];

function txEspia(rows: unknown[] = []) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxFalsa;
  return { tx, llamadas };
}
const igual = (a: unknown, b: unknown) => (Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b);

describe("repositorio de roles: SQL estatico y parametrizado", () => {
  it.each(casos)("$nombre: las entradas viajan como parametros y nunca dentro del texto SQL", async (c) => {
    const { tx, llamadas } = txEspia([]);
    await c.llamar(tx).catch(() => undefined);
    expect(llamadas.length).toBeGreaterThan(0);
    const parametros = llamadas.flatMap((l) => l.valores.flat());
    for (const e of c.entradas) expect(parametros.some((p) => igual(p, e)), `parametro ${String(e)}`).toBe(true);
    for (const e of c.entradas) {
      if (typeof e === "string" && e.length > 12) for (const l of llamadas) expect(l.texto, "el texto SQL no lleva valores").not.toContain(e);
    }
    for (const l of llamadas) expect(l.texto).toMatch(/\$1/);
  });

  it("guardarRol llama a acceso.rol_guardar con (id | null, nombre, alcance, permisos) y devuelve el id", async () => {
    const { tx, llamadas } = txEspia([{ id: R1 }]);
    expect(await guardarRol(tx, DATOS)).toBe(R1);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/acceso\.rol_guardar\(/);
    expect(llamadas[0]!.valores).toEqual([null, "Practicante CANARIO", "asignado", ["clientes.ver", "buzon.ver"]]);
    const e = txEspia([{ id: R1 }]);
    await guardarRol(e.tx, { ...DATOS, id: R1 });
    expect(e.llamadas[0]!.valores[0]).toBe(R1);
  });

  it("eliminarRol llama a acceso.rol_eliminar y no devuelve nada", async () => {
    const { tx, llamadas } = txEspia([{}]);
    expect(await eliminarRol(tx, R1)).toBeUndefined();
    expect(llamadas[0]!.texto).toMatch(/acceso\.rol_eliminar\(/);
    expect(llamadas[0]!.valores).toEqual([R1]);
  });

  it("impactoRol llama a acceso.rol_impacto con (id, alcance, permisos)", async () => {
    const { tx, llamadas } = txEspia([{ miembros: 0, clientes_sin_responsable: 0, miembros_sin_totp_exigidos: 0 }]);
    await impactoRol(tx, R1, { alcance: "global", permisos: ["clientes.ver"] });
    expect(llamadas[0]!.texto).toMatch(/acceso\.rol_impacto\(/);
    expect(llamadas[0]!.valores).toEqual([R1, "global", ["clientes.ver"]]);
  });

  it("el listado y la lectura leen rol y rol_permiso y agregan los permisos en la misma consulta (sin N+1)", async () => {
    for (const llamar of [(tx: TxFalsa) => listarRoles(tx), (tx: TxFalsa) => leerRol(tx, R1)]) {
      const { tx, llamadas } = txEspia([]);
      await llamar(tx);
      expect(llamadas).toHaveLength(1);
      expect(llamadas[0]!.texto).toMatch(/\brol\b/);
      expect(llamadas[0]!.texto).toMatch(/rol_permiso/);
      expect(llamadas[0]!.texto).toMatch(/array_agg/i);
    }
  });

  it("miembroActual trae rol, rol_id, permisos y alcance en UNA consulta con join y array_agg (D4: sin consulta extra)", async () => {
    const { tx, llamadas } = txEspia([]);
    await miembroActual(tx, U1);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/rol_id/);
    expect(llamadas[0]!.texto).toMatch(/rol_permiso/);
    expect(llamadas[0]!.texto).toMatch(/array_agg/i);
    expect(llamadas[0]!.texto).toMatch(/desactivada_en is null/i);
  });
});

describe("repositorio de roles: errores de pg -> AccesoRepoError con solo el SQLSTATE (CA-14)", () => {
  const CANARIO = "CANARIO-ROLES-71c4";
  const errorPg = (code: string) =>
    Object.assign(new Error(`violacion ${CANARIO}`), { code, detail: `Key (nombre)=(${CANARIO})`, where: CANARIO, constraint: CANARIO, table: CANARIO, column: CANARIO });
  const txQueFalla = (code: string) =>
    ({
      query: async () => {
        throw errorPg(code);
      },
    }) as unknown as TxFalsa;

  // SQLSTATE del contrato de 0082: escalada, rol propio del actor, combinacion, limite, rol en uso, nombre repetido, CHECK, rol inexistente
  const CODIGOS = ["42501", "RL001", "22023", "54000", "23503", "23505", "23514", "P0002"];

  it.each(casos.flatMap((c) => CODIGOS.map((codigo) => [c.nombre, codigo, c] as const)))("%s con SQLSTATE %s: AccesoRepoError sin rastro del error original", async (_n, codigo, c) => {
    const e = (await c.llamar(txQueFalla(codigo)).catch((x: unknown) => x)) as Error & { codigo: string };
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e.codigo).toBe(codigo);
    for (const campo of ["detail", "where", "constraint", "table", "column", "cause"]) expect(e, campo).not.toHaveProperty(campo);
    const volcado = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${inspect(e, { depth: 6, showHidden: true })}`;
    expect(volcado).not.toContain(CANARIO);
  });

  it("un error sin SQLSTATE valido da codigo 'desconocido'", async () => {
    const tx = {
      query: async () => {
        throw new Error("x");
      },
    } as unknown as TxFalsa;
    const e = (await guardarRol(tx, DATOS).catch((x: unknown) => x)) as AccesoRepoError;
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e.codigo).toBe("desconocido");
  });
});

describe("repositorio de roles: cero filas y mapeo", () => {
  it("listarRoles sin filas da una lista vacia; leerRol sin filas da null; usoRol sin filas da ceros", async () => {
    expect(await listarRoles(txEspia([]).tx)).toEqual([]);
    expect(await leerRol(txEspia([]).tx, R1)).toBeNull();
    expect(await usoRol(txEspia([]).tx, R1)).toEqual({ miembros: 0, invitaciones: 0 });
  });

  it("listarRoles mapea las filas: permisos ordenados, nulo como vacio y conteos de bigint (texto) como numero", async () => {
    const filas = [
      { id: R1, nombre: "Practicante", alcance: "asignado", permisos: ["sire.descargar", "clientes.ver"], miembros: "3", invitaciones: "1" },
      { id: "r2", nombre: "Vacio", alcance: "global", permisos: null, miembros: 0, invitaciones: 0 },
    ];
    expect(await listarRoles(txEspia(filas).tx)).toEqual([
      { id: R1, nombre: "Practicante", alcance: "asignado", permisos: ["clientes.ver", "sire.descargar"], miembros: 3, invitaciones: 1 },
      { id: "r2", nombre: "Vacio", alcance: "global", permisos: [], miembros: 0, invitaciones: 0 },
    ]);
  });

  it("leerRol mapea la fila (sin conteos)", async () => {
    const r = await leerRol(txEspia([{ id: R1, nombre: "Practicante", alcance: "global", permisos: ["buzon.ver", "clientes.ver"] }]).tx, R1);
    expect(r).toEqual({ id: R1, nombre: "Practicante", alcance: "global", permisos: ["buzon.ver", "clientes.ver"] });
  });

  it("usoRol e impactoRol convierten los conteos a numero y a camelCase", async () => {
    expect(await usoRol(txEspia([{ miembros: "2", invitaciones: "5" }]).tx, R1)).toEqual({ miembros: 2, invitaciones: 5 });
    const i = await impactoRol(txEspia([{ miembros: "4", clientes_sin_responsable: "2", miembros_sin_totp_exigidos: "1" }]).tx, R1, { alcance: "asignado", permisos: [] });
    expect(i).toEqual({ miembros: 4, clientesSinResponsable: 2, miembrosSinTotpExigidos: 1 });
  });

  it("guardarRol sin filas de respuesta falla con AccesoRepoError (nunca devuelve un id inventado)", async () => {
    const e = await guardarRol(txEspia([]).tx, DATOS).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccesoRepoError);
  });
});

describe("miembros e invitaciones con rol propio (D2, CA-1, CA-6)", () => {
  it("miembroActual de un rol propio devuelve rol 'propio', rolId y los permisos y el alcance del rol", async () => {
    const f = { usuario_id: U1, rol: "propio", rol_id: R1, permisos: ["clientes.ver", "buzon.ver"], alcance: "global" };
    expect(await miembroActual(txEspia([f]).tx, U1)).toEqual({
      usuarioId: U1,
      rol: "propio",
      rolId: R1,
      propio: { permisos: ["buzon.ver", "clientes.ver"], alcance: "global" },
    });
  });

  it("miembroActual de un rol propio sin permisos (array_agg nulo) da lista vacia; el de sistema da rolId y propio nulos", async () => {
    const vacio = { usuario_id: U1, rol: "propio", rol_id: R1, permisos: null, alcance: "asignado" };
    expect((await miembroActual(txEspia([vacio]).tx, U1))?.propio).toEqual({ permisos: [], alcance: "asignado" });
    const sistema = { usuario_id: U1, rol: "contador", rol_id: null, permisos: null, alcance: null };
    expect(await miembroActual(txEspia([sistema]).tx, U1)).toEqual({ usuarioId: U1, rol: "contador", rolId: null, propio: null });
  });

  it("ROLES_MIEMBRO incluye 'propio' y listarMiembros / listarInvitaciones lo pasan al filtro (si no, los de rol propio desaparecen de las listas)", async () => {
    expect(ROLES_MIEMBRO).toContain("propio");
    expect(ROLES_MIEMBRO).toHaveLength(6);
    for (const llamar of [(tx: TxFalsa) => listarMiembros(tx), (tx: TxFalsa) => listarInvitaciones(tx)]) {
      const { tx, llamadas } = txEspia([]);
      await llamar(tx);
      expect(llamadas[0]!.valores.flat()).toContain("propio");
    }
  });

  it("listarMiembros e invitaciones traen rolId y rolNombre (nulos en los de sistema)", async () => {
    const m = await listarMiembros(
      txEspia([
        { usuario_id: U1, nombre: "Ana", correo: "a@ejemplo.test", rol: "propio", rol_id: R1, rol_nombre: "Practicante", activo: true },
        { usuario_id: "u2", nombre: "Beto", correo: "b@ejemplo.test", rol: "lectura", rol_id: null, rol_nombre: null, activo: true },
      ]).tx,
    );
    expect(m.map((x) => [x.rol, x.rolId, x.rolNombre])).toEqual([
      ["propio", R1, "Practicante"],
      ["lectura", null, null],
    ]);
    const ahora = new Date();
    const i = await listarInvitaciones(
      txEspia([
        { id: "i1", correo: "c@ejemplo.test", rol: "propio", rol_id: R1, rol_nombre: "Practicante", invitado_por: U1, invitado_por_nombre: "Ana", creada_en: ahora, vence_en: ahora, vencida: false },
      ]).tx,
    );
    expect(i[0]).toMatchObject({ rol: "propio", rolId: R1, rolNombre: "Practicante" });
  });

  it("cambiarRol a un propio escribe rol y rol_id; a uno de sistema deja rol_id en NULL (nunca queda un rol_id colgando)", async () => {
    const a = txEspia([{ usuario_id: U1, rol: "propio", activo: true }]);
    await cambiarRol(a.tx, U1, "propio", false, R1);
    expect(a.llamadas[0]!.texto).toMatch(/rol_id/);
    expect(a.llamadas[0]!.valores).toEqual(expect.arrayContaining([U1, "propio", R1]));
    const b = txEspia([{ usuario_id: U1, rol: "contador", activo: true }]);
    await cambiarRol(b.tx, U1, "contador");
    expect(b.llamadas[0]!.texto).toMatch(/rol_id\s*=\s*(null|\$\d)/i);
    expect(b.llamadas[0]!.valores).not.toContain(R1);
  });

  it("crearInvitacion con rol propio escribe rol_id; con uno de sistema no lleva rol_id", async () => {
    const f = { id: "i1", correo: CORREO, rol: "propio", rol_id: R1, rol_nombre: "Practicante", invitado_por: U1, invitado_por_nombre: "Ana", creada_en: new Date(), vence_en: new Date(), vencida: false };
    const a = txEspia([f]);
    await crearInvitacion(a.tx, { correo: CORREO, rol: "propio", rolId: R1, invitadoPor: U1, tokenHash: H1 });
    expect(a.llamadas.some((l) => /rol_id/.test(l.texto) && l.valores.includes(R1))).toBe(true);
    const b = txEspia([{ ...f, rol: "asistente", rol_id: null, rol_nombre: null }]);
    await crearInvitacion(b.tx, { correo: CORREO, rol: "asistente", invitadoPor: U1, tokenHash: H1 });
    expect(b.llamadas.flatMap((l) => l.valores)).not.toContain(R1);
  });
});
