// Spec 030 (T1, rojo hasta 0082) · CA-8, CA-10, U7, U9, D4: 20 operaciones concurrentes sobre roles propios dan un resultado consistente y sin
// interbloqueos (40P01) ni fallos de serializacion (40001). Cada operacion usa su propia conexion de contapp_backend (withTenant, confirma).
// Rojo por: acceso.rol_guardar / rol_eliminar y las tablas rol / rol_permiso aun no existen (0082).
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirAdmin, abrirApp, hashFalso, llamar } from "./auth-soporte";
import { COD, EscenarioRoles, codigo, ejecutar, eliminar, guardar, type Res } from "./roles-soporte";
import type { ContappDb } from "./soporte";

vi.setConfig({ testTimeout: 90_000 });

let admin: Pool;
let app: Pool;
let er: EscenarioRoles;
let db: ContappDb;
beforeAll(() => {
  admin = abrirAdmin(6);
  app = abrirApp(25);
  er = new EscenarioRoles(admin);
  db = er.backend(25);
});
afterAll(async () => {
  await er?.limpiar();
  await er?.cerrar();
  await app?.end();
  await admin?.end();
});
const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
const cuenta = (rs: Res[]) => {
  const c: Record<string, number> = {};
  for (const r of rs) c[codigo(r)] = (c[codigo(r)] ?? 0) + 1;
  return c;
};
const sinInterbloqueo = (rs: Res[]) => {
  const malos = rs.map(codigo).filter((c) => c === COD.interbloqueo || c === COD.serializacion);
  expect(malos, "interbloqueos o fallos de serializacion").toEqual([]);
};
const ctx = (tenantId: string, u: { id: string }) => ({ tenantId, userId: u.id });

const INVITAR = "insert into invitacion (tenant_id, correo, rol, rol_id, invitado_por, token_hash) values ($1, $2, 'propio', $3, $4, $5)";
const ASIGNAR = "update membresia set rol = 'propio', rol_id = $2 where usuario_id = $1";

describe("U9 y CA-1: crear en paralelo", () => {
  it("25 altas concurrentes con nombres distintos en un estudio vacio: exactamente 20 pasan y 5 dan limite_roles (54000)", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => guardar(db, ctx(x.id, d), { nombre: `Concurrente ${i}`, alcance: "asignado", permisos: ["clientes.ver"] })));
    sinInterbloqueo(rs);
    expect(cuenta(rs)).toEqual({ ok: 20, [COD.limite]: 5 });
    expect(await er.roles(x.id)).toBe(20);
    expect((await adm("select count(*)::int as n from rol_permiso where tenant_id = $1", [x.id]))[0].n).toBe(20);
  });

  it("20 altas concurrentes del mismo nombre (con variantes de mayusculas y tildes): una sola pasa; las demas 23505", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const variantes = ["Revisión", "REVISION", "revision", "Revisión ", "revisión"].map((v) => v.trim());
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => guardar(db, ctx(x.id, d), { nombre: variantes[i % variantes.length]!, alcance: "asignado", permisos: [] })));
    sinInterbloqueo(rs);
    expect(cuenta(rs)).toEqual({ ok: 1, [COD.duplicado]: 19 });
    expect(await er.roles(x.id)).toBe(1);
  });

  it("estudios distintos no se bloquean entre si: 20 altas en 20 estudios pasan todas", async () => {
    const actores = [];
    for (let i = 0; i < 20; i++) {
      const x = await er.estudio();
      actores.push({ x, d: await er.miembro(x.id, "dueno") });
    }
    const rs = await Promise.all(actores.map(({ x, d }) => guardar(db, ctx(x.id, d), { nombre: "Mismo nombre", alcance: "asignado", permisos: [] })));
    sinInterbloqueo(rs);
    expect(cuenta(rs)).toEqual({ ok: 20 });
  });
});

describe("CA-10: eliminar o editar un rol mientras se invita, acepta, cambia de rol o desactiva", () => {
  it("eliminar vs invitar (10 pares): exactamente uno gana; el rol existe si y solo si la invitacion quedo", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const roles = await Promise.all(Array.from({ length: 10 }, () => er.rol(x.id, { permisos: ["clientes.ver"] })));
    const pares = await Promise.all(
      roles.flatMap((r) => [
        eliminar(db, ctx(x.id, d), r.id),
        ejecutar(db, ctx(x.id, d), INVITAR, [x.id, er.esc.correoNuevo(), r.id, d.id, randomBytes(32)]),
      ]),
    );
    sinInterbloqueo(pares);
    for (let i = 0; i < roles.length; i++) {
      const [del, inv] = [pares[2 * i]!, pares[2 * i + 1]!];
      const existe = (await adm("select 1 from rol where id = $1", [roles[i]!.id])).length === 1;
      const invitada = (await adm("select 1 from invitacion where rol_id = $1", [roles[i]!.id])).length === 1;
      expect([codigo(del), codigo(inv)].filter((c) => c === "ok"), `par ${i}: uno solo gana`).toHaveLength(1);
      if (del.ok) {
        expect(codigo(inv)).toBe(COD.enUso); // FK compuesta: el rol ya no existe
        expect([existe, invitada]).toEqual([false, false]);
      } else {
        expect(codigo(del)).toBe(COD.enUso);
        expect([existe, invitada]).toEqual([true, true]);
      }
    }
  });

  it("eliminar vs cambiar el rol de un miembro (10 pares): exactamente uno gana y nunca queda una membresia con rol inexistente", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const objetivos = await Promise.all(Array.from({ length: 10 }, () => er.miembro(x.id, "lectura")));
    const roles = await Promise.all(Array.from({ length: 10 }, () => er.rol(x.id, { permisos: ["clientes.ver"] })));
    const pares = await Promise.all(roles.flatMap((r, i) => [eliminar(db, ctx(x.id, d), r.id), ejecutar(db, ctx(x.id, d), ASIGNAR, [objetivos[i]!.id, r.id])]));
    sinInterbloqueo(pares);
    for (let i = 0; i < roles.length; i++) {
      expect([codigo(pares[2 * i]!), codigo(pares[2 * i + 1]!)].filter((c) => c === "ok"), `par ${i}`).toHaveLength(1);
    }
    const colgadas = await adm("select count(*)::int as n from membresia m where m.tenant_id = $1 and m.rol_id is not null and not exists (select 1 from rol r where r.tenant_id = m.tenant_id and r.id = m.rol_id)", [x.id]);
    expect(colgadas[0].n).toBe(0);
  });

  it("eliminar vs aceptar la invitacion (10 pares): eliminar siempre da en uso y la aceptacion siempre pasa", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const roles = await Promise.all(Array.from({ length: 10 }, () => er.rol(x.id, { permisos: ["clientes.ver"] })));
    const invs = await Promise.all(roles.map((r) => er.invitacionPropia(x.id, r.id, d.id)));
    for (const i of invs) er.recordarCorreo(i.correo);
    const NUEVA = "select auth.invitacion_aceptar_nueva($1::bytea, $2::text, $3::text) as v";
    const dobles = await Promise.all(
      roles.flatMap((r, i) => [
        eliminar(db, ctx(x.id, d), r.id),
        llamar(app, NUEVA, [invs[i]!.tokenHash, "Persona Concurrente", hashFalso()]).then(async (l) => (l.ok ? ({ ok: true, rows: l.rows } as Res) : ({ ok: false, code: l.code, message: "" } as Res))),
      ]),
    );
    sinInterbloqueo(dobles);
    for (let i = 0; i < roles.length; i++) {
      expect(codigo(dobles[2 * i]!), `eliminar ${i}`).toBe(COD.enUso);
      const a = dobles[2 * i + 1]!;
      expect(a.ok && a.rows[0].v, `aceptar ${i}`).toBe("aceptada");
    }
    expect(await er.roles(x.id)).toBe(10);
    expect((await adm("select count(*)::int as n from membresia where tenant_id = $1 and rol = 'propio'", [x.id]))[0].n).toBe(10);
  });

  it("editar (el Dueño amplia el rol) vs asignar (un actor limitado): sin interbloqueos, la edicion siempre pasa y la asignacion o pasa o es escalada", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const debil = await er.actor(x.id, ["usuarios.gestionar", "usuarios.ver", "clientes.ver"], "asignado");
    const roles = await Promise.all(Array.from({ length: 10 }, () => er.rol(x.id, { permisos: ["clientes.ver"] })));
    const objetivos = await Promise.all(roles.map(() => er.miembro(x.id, "lectura")));
    const rs = await Promise.all(
      roles.flatMap((r, i) => [
        guardar(db, ctx(x.id, d), { id: r.id, nombre: r.nombre, alcance: "asignado", permisos: ["clientes.ver", "credenciales.editar"] }),
        ejecutar(db, ctx(x.id, debil), ASIGNAR, [objetivos[i]!.id, r.id]),
      ]),
    );
    sinInterbloqueo(rs);
    for (let i = 0; i < roles.length; i++) {
      expect(codigo(rs[2 * i]!), `edicion ${i}`).toBe("ok");
      const a = codigo(rs[2 * i + 1]!);
      expect(["ok", COD.escalada], `asignacion ${i}`).toContain(a);
      const fila = (await adm("select rol, rol_id from membresia where usuario_id = $1", [objetivos[i]!.id]))[0];
      expect(fila).toEqual(a === "ok" ? { rol: "propio", rol_id: roles[i]!.id } : { rol: "lectura", rol_id: null });
    }
  });

  it("editar el rol (quitar sire.clasificar) vs desactivar a sus miembros (20 en paralelo): sin interbloqueos y ningun responsable queda", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const rol = await er.rol(x.id, { permisos: ["clientes.ver", "sire.clasificar"] });
    const miembros = await Promise.all(Array.from({ length: 10 }, () => er.miembroPropio(x.id, rol.id)));
    const clientes = await Promise.all(miembros.map(() => er.cliente(x.id)));
    await Promise.all(miembros.map((m, i) => er.asignar(x.id, clientes[i]!, m.id, "responsable")));
    const rs = await Promise.all([
      guardar(db, ctx(x.id, d), { id: rol.id, nombre: rol.nombre, alcance: "asignado", permisos: ["clientes.ver"] }),
      ...miembros.map((m) => ejecutar(db, ctx(x.id, d), "update membresia set desactivada_en = now() where usuario_id = $1", [m.id])),
    ]);
    sinInterbloqueo(rs);
    expect(codigo(rs[0]!)).toBe("ok");
    expect((await adm("select count(*)::int as n from asignacion where tenant_id = $1 and tipo = 'responsable'", [x.id]))[0].n).toBe(0);
  });
});

describe("CA-8 / U7: nunca 0 Dueños activos con roles propios, tampoco en concurrencia", () => {
  it("20 Dueños se pasan a un rol propio a la vez: 19 pasan, el ultimo recibe P0001 y queda 1 Dueño activo", async () => {
    const x = await er.estudio();
    const duenos = await Promise.all(Array.from({ length: 20 }, () => er.miembro(x.id, "dueno")));
    const rol = await er.rol(x.id, { alcance: "global", permisos: ["clientes.ver"] });
    const rs = await Promise.all(duenos.map((u) => ejecutar(db, ctx(x.id, u), ASIGNAR, [u.id, rol.id])));
    sinInterbloqueo(rs);
    expect(cuenta(rs)).toEqual({ ok: 19, P0001: 1 });
    expect((await adm("select count(*)::int as n from membresia where tenant_id = $1 and rol = 'dueno' and desactivada_en is null", [x.id]))[0].n).toBe(1);
  });

  it("dos Dueños se degradan o desactivan mutuamente (10 estudios): siempre queda al menos uno, sin interbloqueos", async () => {
    const estudios = await Promise.all(Array.from({ length: 10 }, () => er.estudio()));
    const rs: Res[] = [];
    const parejas = await Promise.all(
      estudios.map(async (x) => {
        const rol = await er.rol(x.id, { alcance: "global", permisos: ["clientes.ver"] });
        return { x, rol, a: await er.miembro(x.id, "dueno"), b: await er.miembro(x.id, "dueno") };
      }),
    );
    rs.push(
      ...(await Promise.all(
        parejas.flatMap(({ x, rol, a, b }, i) => [
          ejecutar(db, ctx(x.id, a), i % 2 === 0 ? ASIGNAR : "update membresia set desactivada_en = now() where usuario_id = $1", i % 2 === 0 ? [b.id, rol.id] : [b.id]),
          ejecutar(db, ctx(x.id, b), i % 2 === 0 ? ASIGNAR : "update membresia set desactivada_en = now() where usuario_id = $1", i % 2 === 0 ? [a.id, rol.id] : [a.id]),
        ]),
      )),
    );
    sinInterbloqueo(rs);
    for (const { x } of parejas) {
      expect((await adm("select count(*)::int as n from membresia where tenant_id = $1 and rol = 'dueno' and desactivada_en is null", [x.id]))[0].n, x.id).toBe(1);
    }
    for (let i = 0; i < rs.length; i += 2) expect([codigo(rs[i]!), codigo(rs[i + 1]!)].sort(), `pareja ${i / 2}`).toEqual(["P0001", "ok"]);
  });
});

describe("D4: orden fijo de bloqueo; mezcla de operaciones sin interbloqueos", () => {
  it("20 operaciones mezcladas (crear, editar, eliminar, asignar, invitar, aceptar) sobre los mismos roles: ninguna da 40P01 ni 40001 y el estado queda consistente", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const roles = await Promise.all(Array.from({ length: 5 }, () => er.rol(x.id, { permisos: ["clientes.ver"] })));
    const objetivos = await Promise.all(Array.from({ length: 5 }, () => er.miembro(x.id, "lectura")));
    const c = ctx(x.id, d);
    const NUEVA = "select auth.invitacion_aceptar_nueva($1::bytea, $2::text, $3::text) as v";
    const aceptables = await Promise.all(roles.slice(0, 2).map((r) => er.invitacionPropia(x.id, r.id, d.id)));
    for (const i of aceptables) er.recordarCorreo(i.correo);
    const ops: Promise<Res>[] = [
      ...roles.map((r) => guardar(db, c, { id: r.id, nombre: r.nombre, alcance: "asignado", permisos: ["clientes.ver", "buzon.ver"] })),
      ...roles.map((r) => eliminar(db, c, r.id)),
      ...roles.map((r, i) => ejecutar(db, c, ASIGNAR, [objetivos[i]!.id, r.id])),
      ...roles.slice(0, 3).map((r) => ejecutar(db, c, INVITAR, [x.id, er.esc.correoNuevo(), r.id, d.id, randomBytes(32)])),
      ...aceptables.map((i) =>
        llamar(app, NUEVA, [i.tokenHash, "Mezcla", hashFalso()]).then((l) => (l.ok ? ({ ok: true, rows: l.rows } as Res) : ({ ok: false, code: l.code, message: "" } as Res))),
      ),
      guardar(db, c, { nombre: "Nuevo en la mezcla", alcance: "asignado", permisos: [] }),
    ];
    expect(ops.length).toBe(20);
    const rs = await Promise.all(ops);
    sinInterbloqueo(rs);
    const colgadas = await adm(
      `select (select count(*)::int from membresia m where m.rol_id is not null and not exists (select 1 from rol r where r.tenant_id = m.tenant_id and r.id = m.rol_id)) as m,
              (select count(*)::int from invitacion i where i.rol_id is not null and not exists (select 1 from rol r where r.tenant_id = i.tenant_id and r.id = i.rol_id)) as i`,
    );
    expect(colgadas).toEqual([{ m: 0, i: 0 }]);
    expect((await adm("select count(*)::int as n from membresia where tenant_id = $1 and rol = 'dueno' and desactivada_en is null", [x.id]))[0].n).toBe(1);
  });
});
