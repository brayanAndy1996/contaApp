// Spec 030 (T1, rojo hasta 0082) · CA-1, CA-2, CA-5, CA-6, CA-8, CA-9, U1-U6, U9: acceso.rol_guardar / rol_eliminar / rol_impacto, la auditoria de
// roles y el disparador de asignacion. Contrato (SQLSTATE, firmas) en el encabezado de `roles-soporte.ts`. Cada prueba crea sus estudios.
// Rojo por: el esquema `acceso` y sus funciones aun no existen (3F000 / 42883) y las tablas rol / rol_permiso (42P01) hasta 0082.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import type { ContappDb } from "./soporte";
import {
  COD,
  EscenarioRoles,
  PERMISOS_ASIGNABLES,
  REGLAS_U3,
  cierreU3,
  codigo,
  eliminar,
  ejecutar,
  guardar,
  impacto,
  permisosDe,
  probar,
  probarGuardar,
} from "./roles-soporte";

vi.setConfig({ testTimeout: 60_000 });

let admin: Pool;
let er: EscenarioRoles;
let dbBackend: ContappDb;
beforeAll(() => {
  admin = abrirAdmin(6);
  er = new EscenarioRoles(admin);
  dbBackend = er.backend(12);
});
afterAll(async () => {
  await er?.limpiar();
  await er?.cerrar();
  await admin?.end();
});

const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
let n = 0;
const nombre = () => `Rol de prueba ${er.esc.marca}-${++n}`;
const ctx = (tenantId: string, u?: { id: string }) => ({ tenantId, ...(u ? { userId: u.id } : {}) });

/** Estudio con un Dueño y un Administrador de sistema (los actores habituales) y la conexion del backend. */
async function base() {
  const x = await er.estudio();
  const dueno = await er.miembro(x.id, "dueno");
  const admin_ = await er.miembro(x.id, "admin");
  return { x, dueno, admin: admin_, db: dbBackend, cD: ctx(x.id, dueno), cA: ctx(x.id, admin_) };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- filas de pg sin tipo
const idDe = (r: { ok: boolean; rows?: any[] }): string => {
  if (!r.ok) throw new Error(`la funcion fallo (SQLSTATE ${r.code})`);
  return r.rows![0].id as string;
};
const filaRol = async (id: string) => (await adm("select nombre, alcance, creado_en, actualizado_en from rol where id = $1", [id]))[0];

describe("acceso.rol_guardar · crear (CA-1, CA-2, U1)", () => {
  it("el Dueño crea un rol: devuelve el id, guarda nombre, alcance y permisos, y el estudio queda con ese unico rol", async () => {
    const { x, db, cD } = await base();
    const permisos = ["clientes.ver", "sire.descargar", "buzon.ver"];
    const id = idDe(await guardar(db, cD, { nombre: "Practicante", alcance: "asignado", permisos }));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await filaRol(id)).toMatchObject({ nombre: "Practicante", alcance: "asignado" });
    expect(await permisosDe(admin, id)).toEqual([...permisos].sort());
    expect(await er.roles(x.id)).toBe(1);
    expect((await adm("select tenant_id from rol where id = $1", [id]))[0].tenant_id).toBe(x.id);
  });

  it("el Administrador (contiene los 23 permisos y es global) puede crear un rol global con los 23; el Dueño tambien (sin plan.gestionar)", async () => {
    const { db, cA, cD } = await base();
    expect(codigo(await guardar(db, cA, { nombre: nombre(), alcance: "global", permisos: PERMISOS_ASIGNABLES }))).toBe("ok");
    expect(codigo(await guardar(db, cD, { nombre: nombre(), alcance: "global", permisos: PERMISOS_ASIGNABLES }))).toBe("ok");
  });

  it("un rol sin permisos es valido", async () => {
    const { db, cD } = await base();
    expect(codigo(await guardar(db, cD, { nombre: nombre(), alcance: "asignado", permisos: [] }))).toBe("ok");
  });

  it.each(["contador", "asistente", "lectura"] as const)("U1: un %s (sin roles.gestionar) no crea roles: 42501 y nada se guarda", async (rol) => {
    const { x, db } = await base();
    const u = await er.miembro(x.id, rol);
    const r = await guardar(db, ctx(x.id, u), { nombre: nombre(), alcance: "asignado", permisos: ["clientes.ver"] });
    expect(codigo(r)).toBe(COD.escalada);
    expect(await er.roles(x.id)).toBe(0);
  });

  it("U1: un rol propio con usuarios.ver pero sin roles.gestionar tampoco: 42501", async () => {
    const { x, db } = await base();
    const a = await er.actor(x.id, ["usuarios.gestionar", "clientes.ver"]);
    expect(codigo(await guardar(db, ctx(x.id, a), { nombre: nombre(), alcance: "asignado", permisos: ["clientes.ver"] }))).toBe(COD.escalada);
  });

  it("sin actor (app.user_id vacio), con un usuario que no es del estudio o con un Dueño desactivado: 42501 y nada se guarda", async () => {
    const { x, db, dueno } = await base();
    const otroEstudio = await er.estudio();
    const ajeno = await er.miembro(otroEstudio.id, "dueno");
    const desactivado = await er.miembro(x.id, "dueno", { desactivada: true });
    const datos = { nombre: nombre(), alcance: "asignado" as const, permisos: ["clientes.ver"] };
    expect(codigo(await guardar(db, ctx(x.id), datos)), "sin actor").toBe(COD.escalada);
    expect(codigo(await guardar(db, ctx(x.id, ajeno), datos)), "miembro de otro estudio").toBe(COD.escalada);
    expect(codigo(await guardar(db, ctx(x.id, desactivado), datos)), "desactivado").toBe(COD.escalada);
    expect(dueno.id).toBeTruthy();
    expect(await er.roles(x.id)).toBe(0);
  });

  it("CA-2: plan.gestionar se rechaza con CHECK 23514 aun si el actor es Dueño; un permiso fuera del catalogo tambien", async () => {
    const { x, db, cD } = await base();
    for (const permisos of [["clientes.ver", "plan.gestionar"], ["clientes.ver", "root.todo"], ["PLAN.GESTIONAR"]]) {
      expect(codigo(await guardar(db, cD, { nombre: nombre(), alcance: "asignado", permisos })), permisos.join()).toBe(COD.check);
    }
    expect(await er.roles(x.id)).toBe(0);
  });

  it("alcance fuera de global/asignado: 23514", async () => {
    const { db, cD } = await base();
    const r = await ejecutar(db, cD, "select acceso.rol_guardar(null, $1, 'todos', '{}') as id", [nombre()]);
    expect(codigo(r)).toBe(COD.check);
  });

  it("CA-1: el nombre es unico por estudio sin mayusculas ni tildes (23505); otro estudio puede repetirlo", async () => {
    const a = await base();
    const b = await base();
    expect(codigo(await guardar(a.db, a.cD, { nombre: "Revisión Fiscal", alcance: "asignado", permisos: [] }))).toBe("ok");
    for (const dup of ["revisión fiscal", "REVISION FISCAL", "Revision fiscal"]) {
      expect(codigo(await guardar(a.db, a.cD, { nombre: dup, alcance: "asignado", permisos: [] })), dup).toBe(COD.duplicado);
    }
    expect(codigo(await guardar(b.db, b.cD, { nombre: "Revisión Fiscal", alcance: "asignado", permisos: [] }))).toBe("ok");
    expect(await er.roles(a.x.id)).toBe(1);
  });

  it.each(["Dueño", "dueno", "ADMINISTRADOR", "Contador", "Asistente", "lectura"])("CA-1: el nombre de sistema %s se rechaza (23514)", async (nom) => {
    const { db, cD } = await base();
    expect(codigo(await guardar(db, cD, { nombre: nom, alcance: "asignado", permisos: [] }))).toBe(COD.check);
  });

  it.each([["vacio", ""], ["41 caracteres", "y".repeat(41)], ["con salto de linea", "A\nB"]])("nombre %s: 23514", async (_n, nom) => {
    const { db, cD } = await base();
    expect(codigo(await guardar(db, cD, { nombre: nom, alcance: "asignado", permisos: [] }))).toBe(COD.check);
  });

  describe("U3: combinaciones (23 reglas)", () => {
    // Actor Dueño: contiene todo; asi solo se prueba U3.
    it.each(REGLAS_U3.map((r) => [`${r.permiso} sin ${r.requiere}`, r] as const))("%s: 22023 y no se guarda nada", async (_n, r) => {
      const { x, db, cD } = await base();
      const permisos = cierreU3([r.permiso]).filter((p) => p !== r.requiere);
      expect(permisos).toContain(r.permiso);
      const res = await guardar(db, cD, { nombre: nombre(), alcance: "asignado", permisos });
      expect(codigo(res)).toBe(COD.combinacion);
      if (!res.ok) {
        expect(res.message).not.toContain(x.id);
        expect(res.message).not.toContain(r.permiso); // mensaje fijo: el nombre del permiso lo da el backend (422)
      }
      expect(await er.roles(x.id)).toBe(0);
    });

    it("cada uno de los 23 permisos con sus requisitos se guarda (se revierte para no gastar el limite)", async () => {
      const { db, cD } = await base();
      const vistos: Record<string, string> = {};
      for (const p of PERMISOS_ASIGNABLES) vistos[p] = codigo(await probarGuardar(db, cD, { nombre: nombre(), alcance: "asignado", permisos: cierreU3([p]) }));
      expect(vistos).toEqual(Object.fromEntries(PERMISOS_ASIGNABLES.map((p) => [p, "ok"])));
    });
  });

  describe("U2 y U4: escalada al crear", () => {
    // Actor propio asignado con roles.gestionar + usuarios.ver + clientes.ver + buzon.ver.
    const permisosActor = ["roles.gestionar", "usuarios.ver", "clientes.ver", "buzon.ver"];

    it("dentro de sus permisos y con alcance asignado: ok; un permiso que no tiene: 42501; alcance global: 42501", async () => {
      const { x, db } = await base();
      const a = await er.actor(x.id, permisosActor, "asignado");
      const c = ctx(x.id, a);
      expect(codigo(await probarGuardar(db, c, { nombre: nombre(), alcance: "asignado", permisos: ["clientes.ver", "buzon.ver"] }))).toBe("ok");
      expect(codigo(await probarGuardar(db, c, { nombre: nombre(), alcance: "asignado", permisos: ["clientes.ver", "sire.descargar"] }))).toBe(COD.escalada);
      expect(codigo(await probarGuardar(db, c, { nombre: nombre(), alcance: "asignado", permisos: ["usuarios.ver", "usuarios.gestionar"] }))).toBe(COD.escalada);
      expect(codigo(await probarGuardar(db, c, { nombre: nombre(), alcance: "global", permisos: ["clientes.ver"] }))).toBe(COD.escalada);
      expect(codigo(await probarGuardar(db, c, { nombre: nombre(), alcance: "global", permisos: [] })), "global aun sin permisos").toBe(COD.escalada);
    });

    it("un actor propio de alcance global puede crear un rol global y uno asignado dentro de sus permisos", async () => {
      const { x, db } = await base();
      const a = await er.actor(x.id, permisosActor, "global");
      const c = ctx(x.id, a);
      expect(codigo(await probarGuardar(db, c, { nombre: nombre(), alcance: "global", permisos: ["clientes.ver"] }))).toBe("ok");
      expect(codigo(await probarGuardar(db, c, { nombre: nombre(), alcance: "asignado", permisos: ["clientes.ver"] }))).toBe("ok");
      expect(codigo(await probarGuardar(db, c, { nombre: nombre(), alcance: "global", permisos: ["reglas.ver", "clientes.ver"] }))).toBe(COD.escalada);
    });

    it("el actor no puede darse a si mismo mas: crear un rol con roles.gestionar exige tenerlo; sin plan.gestionar nadie lo da", async () => {
      const { x, db } = await base();
      const a = await er.actor(x.id, ["roles.gestionar", "usuarios.ver"], "asignado");
      expect(codigo(await probarGuardar(db, ctx(x.id, a), { nombre: nombre(), alcance: "asignado", permisos: ["usuarios.ver", "roles.gestionar"] }))).toBe("ok");
      expect(codigo(await probarGuardar(db, ctx(x.id, a), { nombre: nombre(), alcance: "asignado", permisos: ["plan.gestionar"] }))).toBe(COD.check);
    });
  });

  describe("U9: limite de 20 roles propios por estudio", () => {
    it("el rol 21 da 54000 (limite_roles); eliminar uno libera un cupo; otro estudio tiene su propio limite", async () => {
      const a = await base();
      const b = await base();
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push(idDe(await guardar(a.db, a.cD, { nombre: nombre(), alcance: "asignado", permisos: [] })));
      expect(await er.roles(a.x.id)).toBe(20);
      const r21 = await guardar(a.db, a.cD, { nombre: nombre(), alcance: "asignado", permisos: [] });
      expect(codigo(r21)).toBe(COD.limite);
      if (!r21.ok) expect(r21.message).not.toContain(a.x.id);
      expect(await er.roles(a.x.id)).toBe(20);
      expect(codigo(await guardar(b.db, b.cD, { nombre: nombre(), alcance: "asignado", permisos: [] })), "otro estudio").toBe("ok");
      expect(codigo(await eliminar(a.db, a.cD, ids[0]!))).toBe("ok");
      expect(codigo(await guardar(a.db, a.cD, { nombre: nombre(), alcance: "asignado", permisos: [] }))).toBe("ok");
      expect(await er.roles(a.x.id)).toBe(20);
    });

    it("editar con 20 roles no cuenta como crear: el limite no estorba", async () => {
      const a = await base();
      let ultimo = "";
      for (let i = 0; i < 20; i++) ultimo = idDe(await guardar(a.db, a.cD, { nombre: nombre(), alcance: "asignado", permisos: [] }));
      expect(codigo(await guardar(a.db, a.cD, { id: ultimo, nombre: nombre(), alcance: "asignado", permisos: ["clientes.ver"] }))).toBe("ok");
    });
  });
});

describe("acceso.rol_guardar · editar (CA-4, CA-5, CA-9, U2, U4, U6)", () => {
  it("reemplaza nombre, alcance y permisos conservando el id; actualizado_en avanza y creado_en no cambia", async () => {
    const { x, db, cD } = await base();
    const id = idDe(await guardar(db, cD, { nombre: "Original", alcance: "asignado", permisos: ["clientes.ver", "buzon.ver"] }));
    const antes = await filaRol(id);
    await new Promise((r) => setTimeout(r, 15));
    const r = await guardar(db, cD, { id, nombre: "Renombrado", alcance: "global", permisos: ["clientes.ver", "sire.descargar"] });
    expect(idDe(r)).toBe(id);
    const despues = await filaRol(id);
    expect(despues).toMatchObject({ nombre: "Renombrado", alcance: "global" });
    expect(despues.creado_en).toEqual(antes.creado_en);
    expect(despues.actualizado_en.getTime()).toBeGreaterThan(antes.actualizado_en.getTime());
    expect(await permisosDe(admin, id)).toEqual(["clientes.ver", "sire.descargar"]);
    expect(await er.roles(x.id)).toBe(1);
  });

  it("editar sin renombrar no choca con su propio nombre; renombrar a otro rol existente: 23505", async () => {
    const { db, cD } = await base();
    const a = idDe(await guardar(db, cD, { nombre: "Alfa", alcance: "asignado", permisos: [] }));
    await guardar(db, cD, { nombre: "Beta", alcance: "asignado", permisos: [] });
    expect(codigo(await guardar(db, cD, { id: a, nombre: "ALFA", alcance: "asignado", permisos: ["clientes.ver"] }))).toBe("ok");
    expect(codigo(await guardar(db, cD, { id: a, nombre: "beta", alcance: "asignado", permisos: [] }))).toBe(COD.duplicado);
  });

  it("CA-9: un rol de otro estudio o inexistente: P0002 sin tocar nada; el mensaje no vuelca ids", async () => {
    const a = await base();
    const b = await base();
    const rb = await er.rol(b.x.id, { permisos: ["clientes.ver"] });
    const r = await guardar(a.db, a.cD, { id: rb.id, nombre: "Robado", alcance: "global", permisos: [] });
    expect(codigo(r)).toBe(COD.noExiste);
    if (!r.ok) expect(r.message).not.toContain(rb.id);
    expect(await filaRol(rb.id)).toMatchObject({ nombre: rb.nombre });
    expect(await permisosDe(admin, rb.id)).toEqual(["clientes.ver"]);
    expect(codigo(await guardar(a.db, a.cD, { id: "00000000-0000-4000-8000-00000000dead", nombre: "x", alcance: "asignado", permisos: [] }))).toBe(COD.noExiste);
  });

  it("U1: sin roles.gestionar no edita (42501)", async () => {
    const { x, db } = await base();
    const r = await er.rol(x.id);
    const u = await er.miembro(x.id, "contador");
    expect(codigo(await guardar(db, ctx(x.id, u), { id: r.id, nombre: "Nuevo nombre", alcance: "asignado", permisos: [] }))).toBe(COD.escalada);
    expect((await filaRol(r.id)).nombre).toBe(r.nombre);
  });

  describe("U2 (antes y despues) y U4", () => {
    const permisosActor = ["roles.gestionar", "usuarios.ver", "clientes.ver", "buzon.ver"];

    it("un rol que HOY tiene un permiso que el actor no tiene no se edita, ni siquiera para quitarselo: 42501 y queda intacto", async () => {
      const { x, db } = await base();
      const a = await er.actor(x.id, permisosActor, "asignado");
      const objetivo = await er.rol(x.id, { permisos: ["clientes.ver", "credenciales.editar"] });
      const r = await guardar(db, ctx(x.id, a), { id: objetivo.id, nombre: objetivo.nombre, alcance: "asignado", permisos: ["clientes.ver"] });
      expect(codigo(r)).toBe(COD.escalada);
      expect(await permisosDe(admin, objetivo.id)).toEqual(["clientes.ver", "credenciales.editar"]);
    });

    it("un rol contenido no se puede ampliar mas alla de los permisos del actor (despues): 42501 y queda intacto", async () => {
      const { x, db } = await base();
      const a = await er.actor(x.id, permisosActor, "asignado");
      const objetivo = await er.rol(x.id, { permisos: ["clientes.ver"] });
      expect(codigo(await guardar(db, ctx(x.id, a), { id: objetivo.id, nombre: objetivo.nombre, alcance: "asignado", permisos: ["clientes.ver", "clientes.crear"] }))).toBe(COD.escalada);
      expect(codigo(await guardar(db, ctx(x.id, a), { id: objetivo.id, nombre: objetivo.nombre, alcance: "asignado", permisos: ["clientes.ver", "buzon.ver"] }))).toBe("ok");
    });

    it("U4: un actor de alcance asignado no toca un rol global (antes) ni vuelve global uno asignado (despues)", async () => {
      const { x, db } = await base();
      const a = await er.actor(x.id, permisosActor, "asignado");
      const global_ = await er.rol(x.id, { alcance: "global", permisos: ["clientes.ver"] });
      const asignado = await er.rol(x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
      expect(codigo(await guardar(db, ctx(x.id, a), { id: global_.id, nombre: global_.nombre, alcance: "asignado", permisos: ["clientes.ver"] }))).toBe(COD.escalada);
      expect(codigo(await guardar(db, ctx(x.id, a), { id: asignado.id, nombre: asignado.nombre, alcance: "global", permisos: ["clientes.ver"] }))).toBe(COD.escalada);
      expect((await filaRol(global_.id)).alcance).toBe("global");
      expect((await filaRol(asignado.id)).alcance).toBe("asignado");
    });

    it("U2: nadie edita el rol que tiene asignado (RL001), ni con un cambio inocuo; otro miembro del mismo rol tampoco", async () => {
      const { x, db } = await base();
      const a = await er.actor(x.id, permisosActor, "global");
      const otro = await er.miembroPropio(x.id, a.rolId);
      for (const u of [a, otro]) {
        const r = await guardar(db, ctx(x.id, u), { id: a.rolId, nombre: "Inocuo", alcance: "global", permisos: await permisosDe(admin, a.rolId) });
        expect(codigo(r), u.id).toBe(COD.rolPropio);
      }
      expect(codigo(await eliminar(db, ctx(x.id, a), a.rolId))).toBe(COD.rolPropio);
      expect(await permisosDe(admin, a.rolId)).toEqual(cierreU3(permisosActor).sort());
    });

    it("el Dueño y el Administrador (roles de sistema) editan cualquier rol propio, global o no", async () => {
      const { x, db, cD, cA } = await base();
      const r = await er.rol(x.id, { alcance: "global", permisos: ["clientes.ver", "credenciales.editar"] });
      expect(codigo(await guardar(db, cA, { id: r.id, nombre: r.nombre, alcance: "global", permisos: ["clientes.ver"] }))).toBe("ok");
      expect(codigo(await guardar(db, cD, { id: r.id, nombre: r.nombre, alcance: "asignado", permisos: [...PERMISOS_ASIGNABLES] }))).toBe("ok");
    });
  });

  describe("U6: editar un rol en uso", () => {
    it("quitar sire.clasificar deja sin responsable los clientes de sus miembros; los de otros roles y los colaboradores no cambian", async () => {
      const { x, db, cD } = await base();
      const rol = await er.rol(x.id, { permisos: ["clientes.ver", "sire.clasificar", "sire.descargar"] });
      const m1 = await er.miembroPropio(x.id, rol.id);
      const m2 = await er.miembroPropio(x.id, rol.id);
      const conta = await er.miembro(x.id, "contador");
      const [c1, c2, c3, c4] = [await er.cliente(x.id), await er.cliente(x.id), await er.cliente(x.id), await er.cliente(x.id)];
      await er.asignar(x.id, c1, m1.id, "responsable");
      await er.asignar(x.id, c2, m1.id, "responsable");
      await er.asignar(x.id, c3, m2.id, "colaborador");
      await er.asignar(x.id, c4, conta.id, "responsable");
      const r = await guardar(db, cD, { id: rol.id, nombre: rol.nombre, alcance: "asignado", permisos: ["clientes.ver", "sire.descargar"] });
      expect(codigo(r)).toBe("ok");
      const resp = await adm("select cliente_id, usuario_id from asignacion where tenant_id = $1 and tipo = 'responsable' order by cliente_id", [x.id]);
      expect(resp).toEqual([{ cliente_id: c4, usuario_id: conta.id }]);
      const colab = await adm("select 1 from asignacion where tenant_id = $1 and usuario_id = $2 and cliente_id = $3 and tipo = 'colaborador'", [x.id, m2.id, c3]);
      expect(colab).toHaveLength(1);
    });

    it("conservar sire.clasificar, o ganar permisos, no toca las asignaciones", async () => {
      const { x, db, cD } = await base();
      const rol = await er.rol(x.id, { permisos: ["clientes.ver", "sire.clasificar"] });
      const m = await er.miembroPropio(x.id, rol.id);
      const c = await er.cliente(x.id);
      await er.asignar(x.id, c, m.id, "responsable");
      expect(codigo(await guardar(db, cD, { id: rol.id, nombre: rol.nombre, alcance: "asignado", permisos: ["clientes.ver", "sire.clasificar", "sire.descargar"] }))).toBe("ok");
      expect(await adm("select 1 from asignacion where tenant_id = $1 and usuario_id = $2 and tipo = 'responsable'", [x.id, m.id])).toHaveLength(1);
    });

    it("si la edicion falla (escalada) no se borra ninguna asignacion: todo o nada", async () => {
      const { x, db } = await base();
      const a = await er.actor(x.id, ["roles.gestionar", "usuarios.ver", "clientes.ver"], "asignado");
      const rol = await er.rol(x.id, { permisos: ["clientes.ver", "sire.clasificar"] });
      const m = await er.miembroPropio(x.id, rol.id);
      const c = await er.cliente(x.id);
      await er.asignar(x.id, c, m.id, "responsable");
      // el actor no tiene sire.clasificar: el rol esta fuera de sus permisos
      expect(codigo(await guardar(db, ctx(x.id, a), { id: rol.id, nombre: rol.nombre, alcance: "asignado", permisos: ["clientes.ver"] }))).toBe(COD.escalada);
      expect(await adm("select 1 from asignacion where tenant_id = $1 and usuario_id = $2 and tipo = 'responsable'", [x.id, m.id])).toHaveLength(1);
    });
  });
});

describe("acceso.rol_eliminar (CA-6, CA-9, U2, U5)", () => {
  it("elimina un rol libre con sus permisos y libera el nombre", async () => {
    const { x, db, cD } = await base();
    const id = idDe(await guardar(db, cD, { nombre: "Temporal", alcance: "asignado", permisos: ["clientes.ver"] }));
    expect(codigo(await eliminar(db, cD, id))).toBe("ok");
    expect(await adm("select 1 from rol where id = $1", [id])).toHaveLength(0);
    expect(await adm("select 1 from rol_permiso where rol_id = $1", [id])).toHaveLength(0);
    expect(codigo(await guardar(db, cD, { nombre: "temporal", alcance: "asignado", permisos: [] }))).toBe("ok");
    expect(await er.roles(x.id)).toBe(1);
  });

  it("U5: con un miembro activo: 23503 y todo sigue igual", async () => {
    const { x, db, cD } = await base();
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const m = await er.miembroPropio(x.id, rol.id);
    const r = await eliminar(db, cD, rol.id);
    expect(codigo(r)).toBe(COD.enUso);
    if (!r.ok) expect(r.message).not.toContain(rol.id);
    expect(await permisosDe(admin, rol.id)).toEqual(["clientes.ver"]);
    expect((await adm("select rol_id from membresia where usuario_id = $1", [m.id]))[0].rol_id).toBe(rol.id);
  });

  it("U5: con una invitacion vigente: 23503; y la invitacion puede aceptarse despues", async () => {
    const { x, db, cD, dueno } = await base();
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    await er.invitacionPropia(x.id, rol.id, dueno.id);
    expect(codigo(await eliminar(db, cD, rol.id))).toBe(COD.enUso);
    expect(await er.roles(x.id)).toBe(1);
  });

  // La spec dice «miembros activos o invitaciones vigentes», pero la FK RESTRICT (D2) tambien protege a las filas desactivadas, revocadas,
  // vencidas o aceptadas. CA-6: NUNCA queda una membresia o invitacion con un rol inexistente. T6 elige: rechazar (23503) o reasignar/limpiar
  // esas filas en la misma transaccion; la prueba solo fija el invariante (T17 revisa la eleccion).
  it.each([
    ["miembro desactivado", async (x: string, rolId: string) => void (await er.miembroPropio(x, rolId, { desactivada: true }))],
    ["invitacion revocada", async (x: string, rolId: string, d: string) => void (await er.invitacionPropia(x, rolId, d, { revocada: true }))],
    ["invitacion vencida", async (x: string, rolId: string, d: string) => void (await er.invitacionPropia(x, rolId, d, { vencida: true }))],
    ["invitacion aceptada", async (x: string, rolId: string, d: string) => void (await er.invitacionPropia(x, rolId, d, { aceptada: true }))],
  ])("invariante CA-6 con %s: se rechaza (23503) o se limpia, pero nunca queda una fila con rol inexistente", async (_n, sembrar) => {
    const { x, db, cD, dueno } = await base();
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    await sembrar(x.id, rol.id, dueno.id);
    const r = await eliminar(db, cD, rol.id);
    expect(["ok", COD.enUso]).toContain(codigo(r));
    const colgadas = await adm(
      `select (select count(*)::int from membresia m where m.rol_id is not null and not exists (select 1 from rol r where r.tenant_id = m.tenant_id and r.id = m.rol_id)) as m,
              (select count(*)::int from invitacion i where i.rol_id is not null and not exists (select 1 from rol r where r.tenant_id = i.tenant_id and r.id = i.rol_id)) as i`,
    );
    expect(colgadas).toEqual([{ m: 0, i: 0 }]);
    const huerfanas = await adm("select count(*)::int as n from membresia where tenant_id = $1 and rol = 'propio' and rol_id is null", [x.id]);
    expect(huerfanas[0].n).toBe(0);
  });

  it("CA-9: un rol de otro estudio o inexistente: P0002 y el rol ajeno sigue", async () => {
    const a = await base();
    const b = await base();
    const rb = await er.rol(b.x.id);
    expect(codigo(await eliminar(a.db, a.cD, rb.id))).toBe(COD.noExiste);
    expect(codigo(await eliminar(a.db, a.cD, "00000000-0000-4000-8000-00000000dead"))).toBe(COD.noExiste);
    expect(await er.roles(b.x.id)).toBe(1);
  });

  it("U1 y U2: sin roles.gestionar 42501; un rol con permisos que el actor no tiene 42501; el rol que tiene asignado RL001", async () => {
    const { x, db } = await base();
    const conta = await er.miembro(x.id, "contador");
    const a = await er.actor(x.id, ["roles.gestionar", "usuarios.ver", "clientes.ver"], "asignado");
    const libre = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const mayor = await er.rol(x.id, { permisos: ["clientes.ver", "credenciales.editar"] });
    const global_ = await er.rol(x.id, { alcance: "global", permisos: [] });
    expect(codigo(await eliminar(db, ctx(x.id, conta), libre.id))).toBe(COD.escalada);
    expect(codigo(await eliminar(db, ctx(x.id, a), mayor.id)), "permisos fuera del actor").toBe(COD.escalada);
    expect(codigo(await eliminar(db, ctx(x.id, a), global_.id)), "alcance global con actor asignado").toBe(COD.escalada);
    expect(codigo(await eliminar(db, ctx(x.id, a), a.rolId))).toBe(COD.rolPropio);
    expect(await er.roles(x.id)).toBe(4);
    expect(codigo(await eliminar(db, ctx(x.id, a), libre.id)), "contenido y con alcance suficiente: si puede").toBe("ok");
    expect(await er.roles(x.id)).toBe(3);
  });
});

describe("acceso.rol_impacto (U6, U8): solo lee", () => {
  const totpActivo = async (usuarioId: string) =>
    admin.query("insert into auth.totp (usuario_id, activo_cifrado, activo_version, ultimo_paso, activado_en) values ($1, $2, 1, 0, now())", [usuarioId, randomBytes(48)]);

  it("cuenta miembros, clientes que quedarian sin responsable y miembros sin TOTP que pasarian a exigirlo", async () => {
    const { x, db, cD } = await base();
    const rol = await er.rol(x.id, { permisos: ["clientes.ver", "sire.clasificar"] });
    const m1 = await er.miembroPropio(x.id, rol.id);
    const m2 = await er.miembroPropio(x.id, rol.id);
    await er.miembroPropio(x.id, rol.id, { desactivada: true });
    const [c1, c2, c3] = [await er.cliente(x.id), await er.cliente(x.id), await er.cliente(x.id)];
    await er.asignar(x.id, c1, m1.id, "responsable");
    await er.asignar(x.id, c2, m1.id, "responsable");
    await er.asignar(x.id, c3, m2.id, "colaborador");
    await totpActivo(m1.id);
    // quitar sire.clasificar: 2 miembros activos, 2 clientes sin responsable, nadie nuevo exigido de TOTP
    const quita = await impacto(db, cD, rol.id, "asignado", ["clientes.ver"]);
    expect(quita.ok && quita.rows).toEqual([{ miembros: 2, clientes_sin_responsable: 2, miembros_sin_totp_exigidos: 0 }]);
    // ganar credenciales.editar (sensible): m2 no tiene TOTP y pasa a exigirlo; m1 ya lo tiene
    const gana = await impacto(db, cD, rol.id, "asignado", ["clientes.ver", "sire.clasificar", "credenciales.editar"]);
    expect(gana.ok && gana.rows).toEqual([{ miembros: 2, clientes_sin_responsable: 0, miembros_sin_totp_exigidos: 1 }]);
  });

  it("un rol que ya tenia un sensible no cuenta como nuevo exigido; quitar sensibles tampoco", async () => {
    const { x, db, cD } = await base();
    const rol = await er.rol(x.id, { permisos: ["usuarios.ver", "usuarios.gestionar"] });
    await er.miembroPropio(x.id, rol.id);
    const mas = await impacto(db, cD, rol.id, "asignado", ["usuarios.ver", "usuarios.gestionar", "clientes.ver", "credenciales.editar"]);
    const menos = await impacto(db, cD, rol.id, "asignado", ["usuarios.ver"]);
    expect(mas.ok && mas.rows[0].miembros_sin_totp_exigidos).toBe(0);
    expect(menos.ok && menos.rows[0].miembros_sin_totp_exigidos).toBe(0);
  });

  it("no cambia nada: ni permisos, ni asignaciones, ni auditoria", async () => {
    const { x, db, cD } = await base();
    const rol = await er.rol(x.id, { permisos: ["clientes.ver", "sire.clasificar"] });
    const m = await er.miembroPropio(x.id, rol.id);
    const c = await er.cliente(x.id);
    await er.asignar(x.id, c, m.id, "responsable");
    const antes = (await adm("select count(*)::int as n from auditoria where tenant_id = $1", [x.id]))[0].n;
    expect(codigo(await impacto(db, cD, rol.id, "global", []))).toBe("ok");
    expect(await permisosDe(admin, rol.id)).toEqual(["clientes.ver", "sire.clasificar"]);
    expect((await filaRol(rol.id)).alcance).toBe("asignado");
    expect(await adm("select 1 from asignacion where tenant_id = $1 and tipo = 'responsable'", [x.id])).toHaveLength(1);
    expect((await adm("select count(*)::int as n from auditoria where tenant_id = $1", [x.id]))[0].n).toBe(antes);
  });

  it("exige roles.gestionar (42501) y un rol del estudio (P0002 si es ajeno)", async () => {
    const a = await base();
    const b = await base();
    const rb = await er.rol(b.x.id);
    const conta = await er.miembro(a.x.id, "contador");
    const propio = await er.rol(a.x.id);
    expect(codigo(await impacto(a.db, ctx(a.x.id, conta), propio.id, "asignado", []))).toBe(COD.escalada);
    expect(codigo(await impacto(a.db, a.cD, rb.id, "asignado", []))).toBe(COD.noExiste);
  });
});

describe("auditoria de roles (017; permisos y alcance antes y despues)", () => {
  const eventos = (t: string) =>
    adm("select accion, entidad, entidad_id, actor_tipo, usuario_id, datos from auditoria where tenant_id = $1 and entidad = 'rol' order by ocurrida_en, id", [t]);
  const ord = (a: unknown) => (a as string[]).slice().sort();

  it("el CHECK de auditoria.accion admite rol.creado, rol.editado y rol.eliminado y conserva las anteriores", async () => {
    const [{ d }] = await adm("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'auditoria_accion_valida'");
    for (const a of ["rol.creado", "rol.editado", "rol.eliminado", "miembro.rol_cambiado", "correo.preferencia_cambiada"]) expect(d, a).toContain(`'${a}'`);
  });

  it("crear, editar y eliminar dejan un evento cada uno, con actor usuario y datos antes/despues", async () => {
    const { x, db, cD, dueno } = await base();
    const id = idDe(await guardar(db, cD, { nombre: "Auditado", alcance: "asignado", permisos: ["clientes.ver", "buzon.ver"] }));
    await guardar(db, cD, { id, nombre: "Auditado 2", alcance: "global", permisos: ["clientes.ver", "sire.descargar"] });
    await eliminar(db, cD, id);
    const ev = await eventos(x.id);
    expect(ev.map((e) => e.accion)).toEqual(["rol.creado", "rol.editado", "rol.eliminado"]);
    for (const e of ev) expect(e).toMatchObject({ entidad: "rol", entidad_id: id, actor_tipo: "usuario", usuario_id: dueno.id });
    const [c, e, b] = ev.map((r) => r.datos);
    expect(c.antes ?? null).toBeNull();
    expect(c.despues.alcance).toBe("asignado");
    expect(ord(c.despues.permisos)).toEqual(["buzon.ver", "clientes.ver"]);
    expect(e.antes.alcance).toBe("asignado");
    expect(ord(e.antes.permisos)).toEqual(["buzon.ver", "clientes.ver"]);
    expect(e.despues.alcance).toBe("global");
    expect(ord(e.despues.permisos)).toEqual(["clientes.ver", "sire.descargar"]);
    expect(b.despues ?? null).toBeNull();
    expect(b.antes.alcance).toBe("global");
    expect(ord(b.antes.permisos)).toEqual(["clientes.ver", "sire.descargar"]);
  });

  it("una operacion rechazada (escalada, 422, 409) no deja evento", async () => {
    const { x, db, cD } = await base();
    const a = await er.actor(x.id, ["roles.gestionar", "usuarios.ver"], "asignado");
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    await er.miembroPropio(x.id, rol.id);
    await guardar(db, ctx(x.id, a), { nombre: nombre(), alcance: "global", permisos: [] });
    await guardar(db, cD, { nombre: nombre(), alcance: "asignado", permisos: ["plan.gestionar"] });
    await eliminar(db, cD, rol.id);
    expect(await eventos(x.id)).toEqual([]);
  });

  it("la auditoria es de solo agregado y no guarda el nombre de los permisos de otro estudio ni ids ajenos", async () => {
    const a = await base();
    const b = await base();
    await guardar(b.db, b.cD, { nombre: "Solo de B", alcance: "asignado", permisos: ["credenciales.editar", "clientes.ver"] });
    await guardar(a.db, a.cD, { nombre: "Solo de A", alcance: "asignado", permisos: ["clientes.ver"] });
    expect((await eventos(a.x.id)).map((e) => e.accion), "A si deja su evento").toEqual(["rol.creado"]);
    expect((await eventos(b.x.id)).map((e) => e.accion), "B tambien el suyo").toEqual(["rol.creado"]);
    const volcado = JSON.stringify(await eventos(a.x.id));
    expect(volcado).not.toContain("credenciales.editar");
    expect(volcado).not.toContain(b.x.id);
  });
});

describe("disparador de asignacion de un rol propio (CA-5, U2, U4, D2)", () => {
  const permisosActor = ["usuarios.gestionar", "usuarios.ver", "clientes.ver", "buzon.ver"];
  const ALTA = "insert into membresia (tenant_id, usuario_id, rol, rol_id) values ($1, $2, 'propio', $3)";
  const CAMBIO = "update membresia set rol = 'propio', rol_id = $2 where usuario_id = $1";
  const INVITAR =
    "insert into invitacion (tenant_id, correo, rol, rol_id, invitado_por, token_hash) values ($1, $2, 'propio', $3, $4, $5)";
  const token = () => randomBytes(32);

  it("alta de membresia con un rol propio contenido en el actor: ok; con un permiso fuera de sus permisos: 42501", async () => {
    const { x, db } = await base();
    const a = await er.actor(x.id, permisosActor, "asignado");
    const contenido = await er.rol(x.id, { permisos: ["clientes.ver", "buzon.ver"] });
    const mayor = await er.rol(x.id, { permisos: ["clientes.ver", "sire.descargar"] });
    const [u1, u2] = [await er.cuenta(), await er.cuenta()];
    expect(codigo(await probar(db, ctx(x.id, a), ALTA, [x.id, u1.id, contenido.id]))).toBe("ok");
    expect(codigo(await probar(db, ctx(x.id, a), ALTA, [x.id, u2.id, mayor.id]))).toBe(COD.escalada);
  });

  it("U4: un actor de alcance asignado no asigna un rol global; uno global si (dentro de sus permisos)", async () => {
    const { x, db } = await base();
    const asignado = await er.actor(x.id, permisosActor, "asignado");
    const global_ = await er.actor(x.id, permisosActor, "global");
    const rolGlobal = await er.rol(x.id, { alcance: "global", permisos: ["clientes.ver"] });
    const u = await er.cuenta();
    expect(codigo(await probar(db, ctx(x.id, asignado), ALTA, [x.id, u.id, rolGlobal.id]))).toBe(COD.escalada);
    expect(codigo(await probar(db, ctx(x.id, global_), ALTA, [x.id, u.id, rolGlobal.id]))).toBe("ok");
  });

  it("el Dueño y el Administrador asignan cualquier rol propio (global y con los 23 permisos)", async () => {
    const { x, db, cD, cA } = await base();
    const todo = await er.rol(x.id, { alcance: "global", permisos: [...PERMISOS_ASIGNABLES] });
    const [u1, u2] = [await er.cuenta(), await er.cuenta()];
    expect(codigo(await probar(db, cD, ALTA, [x.id, u1.id, todo.id]))).toBe("ok");
    expect(codigo(await probar(db, cA, ALTA, [x.id, u2.id, todo.id]))).toBe("ok");
  });

  it("cambiar el rol de un miembro existente a uno propio aplica la misma regla", async () => {
    const { x, db } = await base();
    const a = await er.actor(x.id, permisosActor, "asignado");
    const objetivo = await er.miembro(x.id, "lectura");
    const contenido = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const mayor = await er.rol(x.id, { permisos: ["clientes.ver", "clientes.crear"] });
    expect(codigo(await probar(db, ctx(x.id, a), CAMBIO, [objetivo.id, mayor.id]))).toBe(COD.escalada);
    expect(codigo(await probar(db, ctx(x.id, a), CAMBIO, [objetivo.id, contenido.id]))).toBe("ok");
  });

  it("sin actor (app.user_id vacio), un actor de otro estudio o un actor desactivado: 42501 (fail closed para contapp_backend)", async () => {
    const { x, db } = await base();
    const otro = await er.estudio();
    const ajeno = await er.miembro(otro.id, "dueno");
    const desactivado = await er.miembro(x.id, "dueno", { desactivada: true });
    const rol = await er.rol(x.id, { permisos: [] });
    const u = await er.cuenta();
    expect(codigo(await probar(db, ctx(x.id), ALTA, [x.id, u.id, rol.id])), "sin actor").toBe(COD.escalada);
    expect(codigo(await probar(db, ctx(x.id, ajeno), ALTA, [x.id, u.id, rol.id])), "de otro estudio").toBe(COD.escalada);
    expect(codigo(await probar(db, ctx(x.id, desactivado), ALTA, [x.id, u.id, rol.id])), "desactivado").toBe(COD.escalada);
  });

  it("un rol de otro estudio no se asigna aunque el actor sea Dueño: FK compuesta 23503 (CA-9)", async () => {
    const a = await base();
    const b = await base();
    const rb = await er.rol(b.x.id);
    const u = await er.cuenta();
    expect(codigo(await probar(a.db, a.cD, ALTA, [a.x.id, u.id, rb.id]))).toBe(COD.enUso);
  });

  it("invitar con un rol propio: la misma regla (contenido ok, mayor 42501, global con actor asignado 42501)", async () => {
    const { x, db } = await base();
    const a = await er.actor(x.id, permisosActor, "asignado");
    const contenido = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const mayor = await er.rol(x.id, { permisos: ["clientes.ver", "sire.descargar"] });
    const global_ = await er.rol(x.id, { alcance: "global", permisos: [] });
    const inv = (rolId: string) => probar(db, ctx(x.id, a), INVITAR, [x.id, er.esc.correoNuevo(), rolId, a.id, token()]);
    expect(codigo(await inv(contenido.id))).toBe("ok");
    expect(codigo(await inv(mayor.id))).toBe(COD.escalada);
    expect(codigo(await inv(global_.id))).toBe(COD.escalada);
  });

  it("solo vigila la ASIGNACION: desactivar o reactivar a un miembro cuyo rol excede al actor no dispara la regla", async () => {
    const { x, db } = await base();
    const a = await er.actor(x.id, permisosActor, "asignado");
    const mayor = await er.rol(x.id, { alcance: "global", permisos: ["clientes.ver", "credenciales.editar"] });
    const m = await er.miembroPropio(x.id, mayor.id);
    expect(codigo(await probar(db, ctx(x.id, a), "update membresia set desactivada_en = now() where usuario_id = $1", [m.id]))).toBe("ok");
  });

  it("asignar un rol de sistema sigue como en 005 (el disparador no interviene)", async () => {
    const { x, db, cD } = await base();
    const u = await er.cuenta();
    expect(codigo(await probar(db, cD, "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'contador')", [x.id, u.id]))).toBe("ok");
  });
});
