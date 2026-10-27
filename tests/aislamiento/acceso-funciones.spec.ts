// Spec 005 (T2, rojo): comportamiento del trigger del ultimo Dueño (CA-10), de las funciones `auth.*`
// redefinidas con membresia activa (CA-9, D9) y de las tres funciones de invitacion (CA-3, CA-14, D7, D15).
// Cada prueba crea sus estudios y usuarios (EscenarioAcceso) y los borra al final; ninguna toca el seed.
//
// Contrato que fija (T7, migraciones 0012 y 0013):
// - Trigger: degradar, desactivar (desactivada_en) o borrar al unico Dueño ACTIVO de un estudio -> error P0001
//   (mensaje fijo, sin ids) y la fila queda intacta; se bloquea por estudio (dos Dueños que se degradan a la vez
//   dejan uno); solo mira transiciones: un estudio sin Dueño (fixtures) no bloquea otras filas.
// - auth.sesion_validar / login_exito / sesion_rotar / ultimo_estudio exigen membresia con desactivada_en IS NULL.
// - auth.invitacion_vigente(token_hash) -> (estudio_nombre, correo, rol, cuenta_existe): sin efectos; cero filas si la
//   invitacion esta aceptada, revocada o vencida (vence_en <= now()) o no existe.
// - auth.invitacion_aceptar_nueva(token_hash, nombre, hash) -> text: 'aceptada' (crea usuario, credencial y
//   membresia con el rol invitado y marca aceptada_en/aceptada_por, todo en una transaccion), 'cuenta_existe' (el
//   correo ya tiene cuenta; no consume ni cambia su contrasena) o 'invalida' (token desconocido, aceptado,
//   revocado o vencido). Bloquea la invitacion FOR UPDATE: dos aceptaciones concurrentes -> una sola.
// - auth.invitacion_aceptar_existente(token_hash, token_hash_sesion) -> (tenant_id, estudio_nombre): usa el usuario
//   de la sesion viva; el correo debe ser EXACTAMENTE el de la invitacion y no tener membresia previa (ni desactivada);
//   en cualquier otro caso cero filas y sin efectos.
// "Rechazar" = lanzar un error de PG o devolver cero filas / 'invalida' (la prueba admite ambas), sin efectos.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAcceso, sha256 } from "./acceso-soporte";
import { abrirAdmin, abrirApp, crearDb, exito, hashFalso, llamar, nuevoToken } from "./auth-soporte";
import type { ContappDb, Intento } from "./soporte";
import { intentar } from "./soporte";

let app: Pool;
let admin: Pool;
let ea: EscenarioAcceso;
const dbs: ContappDb[] = [];

beforeAll(() => {
  app = abrirApp(30);
  admin = abrirAdmin(6);
  ea = new EscenarioAcceso(admin);
});
afterAll(async () => {
  await ea?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await app?.end();
  await admin?.end();
});

const dbBackend = (max = 2): ContappDb => {
  const d = crearDb("contapp_backend", max);
  dbs.push(d);
  return d;
};
const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rechazada = (r: { ok: boolean; rows?: unknown[] }) => !r.ok || (r.rows ?? []).length === 0;
const codigo = (i: Intento): string => (i.ok ? "ok" : i.code);

// =================================================================================================
describe("trigger membresia_ultimo_dueno (CA-10, D10)", () => {
  const duenosActivos = async (t: string) =>
    Number(
      (await adm("select count(*)::int as n from membresia where tenant_id = $1 and rol = 'dueno' and desactivada_en is null", [t]))[0].n,
    );
  const fila = async (t: string, u: string) =>
    (await adm("select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [t, u]))[0];

  const OPERACIONES: [string, string][] = [
    ["degradar a admin", "update membresia set rol = 'admin' where usuario_id = $1"],
    ["degradar a lectura", "update membresia set rol = 'lectura' where usuario_id = $1"],
    ["desactivar", "update membresia set desactivada_en = now() where usuario_id = $1"],
    ["borrar la membresia", "delete from membresia where usuario_id = $1"],
  ];

  it.each(OPERACIONES)("contapp_backend no puede %s al unico Dueño activo: error P0001 y la BD queda intacta", async (_n, sql) => {
    const x = await ea.estudio();
    const dueno = await ea.miembro(x.id, "dueno");
    await ea.miembro(x.id, "admin");
    await ea.miembro(x.id, "contador");
    const r = await intentar(dbBackend(), { tenantId: x.id }, sql, [dueno.id]);
    expect(codigo(r)).toBe("P0001");
    if (!r.ok) {
      // mensaje fijo: no revela ids del estudio ni del usuario
      expect(r.message).not.toContain(x.id);
      expect(r.message).not.toContain(dueno.id);
    }
    expect(await fila(x.id, dueno.id)).toEqual({ rol: "dueno", desactivada_en: null });
    expect(await duenosActivos(x.id)).toBe(1);
  });

  it.each(OPERACIONES)("el superusuario tampoco puede %s al unico Dueño activo (el trigger vale en la BD)", async (_n, sql) => {
    const x = await ea.estudio();
    const dueno = await ea.miembro(x.id, "dueno");
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      const e = await c.query(sql, [dueno.id]).catch((err) => err);
      expect((e as { code?: string }).code).toBe("P0001");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    expect(await duenosActivos(x.id)).toBe(1);
  });

  it("control: con dos Dueños activos se puede degradar, desactivar o borrar a uno", async () => {
    for (const [nombre, sql] of OPERACIONES) {
      const x = await ea.estudio();
      const d1 = await ea.miembro(x.id, "dueno");
      await ea.miembro(x.id, "dueno");
      const r = await intentar(dbBackend(), { tenantId: x.id }, sql, [d1.id]);
      expect(r, nombre).toEqual({ ok: true, rowCount: 1 });
    }
  });

  it("un Dueño desactivado no cuenta: el unico activo sigue protegido y el desactivado se puede tocar", async () => {
    const x = await ea.estudio();
    const activo = await ea.miembro(x.id, "dueno");
    const inactivo = await ea.miembro(x.id, "dueno", { desactivada: true });
    const protegido = await intentar(dbBackend(), { tenantId: x.id }, OPERACIONES[0]![1], [activo.id]);
    expect(codigo(protegido)).toBe("P0001");
    // OLD no era Dueño activo: degradar o borrar al desactivado no deja al estudio sin Dueño activo
    expect(await intentar(dbBackend(), { tenantId: x.id }, OPERACIONES[0]![1], [inactivo.id])).toEqual({ ok: true, rowCount: 1 });
    expect(await intentar(dbBackend(), { tenantId: x.id }, OPERACIONES[3]![1], [inactivo.id])).toEqual({ ok: true, rowCount: 1 });
  });

  it("reactivar a un Dueño desactivado, y cambios que no tocan rol ni estado del unico Dueño, no se bloquean", async () => {
    const x = await ea.estudio();
    const activo = await ea.miembro(x.id, "dueno");
    const inactivo = await ea.miembro(x.id, "dueno", { desactivada: true });
    expect(
      await intentar(dbBackend(), { tenantId: x.id }, "update membresia set desactivada_en = null where usuario_id = $1", [inactivo.id]),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(
      await intentar(dbBackend(), { tenantId: x.id }, "update membresia set updated_at = now() where usuario_id = $1", [activo.id]),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(
      await intentar(dbBackend(), { tenantId: x.id }, "update membresia set rol = 'dueno' where usuario_id = $1", [activo.id]),
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("un estudio sin Dueño (fixtures) no bloquea otras filas ni a otros estudios", async () => {
    const huerfano = await ea.estudio();
    const a = await ea.miembro(huerfano.id, "admin");
    const b = await ea.miembro(huerfano.id, "contador");
    const c = await ea.miembro(huerfano.id, "lectura");
    const db = dbBackend();
    expect(await intentar(db, { tenantId: huerfano.id }, "update membresia set rol = 'asistente' where usuario_id = $1", [b.id])).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(
      await intentar(db, { tenantId: huerfano.id }, "update membresia set desactivada_en = now() where usuario_id = $1", [a.id]),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(await intentar(db, { tenantId: huerfano.id }, "delete from membresia where usuario_id = $1", [c.id])).toEqual({
      ok: true,
      rowCount: 1,
    });
    // el invariante de OTRO estudio sigue vigente
    const otro = await ea.estudio();
    const unico = await ea.miembro(otro.id, "dueno");
    expect(codigo(await intentar(db, { tenantId: otro.id }, OPERACIONES[0]![1], [unico.id]))).toBe("P0001");
  });

  it.each([
    ["degradarse", "update membresia set rol = 'admin' where usuario_id = $1"],
    ["desactivarse", "update membresia set desactivada_en = now() where usuario_id = $1"],
  ])("dos Dueños que van a %s a la vez: exactamente uno lo logra y queda un Dueño activo (conexiones separadas)", async (_n, sql) => {
    const x = await ea.estudio();
    const d1 = await ea.miembro(x.id, "dueno");
    const d2 = await ea.miembro(x.id, "dueno");
    const cambiar = (db: ContappDb, u: string) =>
      db.withTenant({ tenantId: x.id }, async (tx) => {
        await tx.query(sql, [u]);
        await tx.query("select pg_sleep(0.6)"); // mantiene abierta la transaccion para forzar el solape
      });
    const r = await Promise.allSettled([
      cambiar(dbBackend(1), d1.id),
      dormir(200).then(() => cambiar(dbBackend(1), d2.id)),
    ]);
    expect(r.filter((q) => q.status === "fulfilled")).toHaveLength(1);
    const perdedora = r.find((q): q is PromiseRejectedResult => q.status === "rejected");
    expect((perdedora?.reason as { code?: string } | undefined)?.code).toBe("P0001");
    expect(await duenosActivos(x.id)).toBe(1);
  });

  it("tres Dueños que se degradan a la vez dejan al menos uno", async () => {
    const x = await ea.estudio();
    const ds = [await ea.miembro(x.id, "dueno"), await ea.miembro(x.id, "dueno"), await ea.miembro(x.id, "dueno")];
    const r = await Promise.allSettled(
      ds.map((d, i) =>
        dormir(i * 100).then(() =>
          dbBackend(1).withTenant({ tenantId: x.id }, async (tx) => {
            await tx.query("update membresia set rol = 'admin' where usuario_id = $1", [d.id]);
            await tx.query("select pg_sleep(0.5)");
          }),
        ),
      ),
    );
    expect(r.filter((q) => q.status === "fulfilled")).toHaveLength(2);
    expect(await duenosActivos(x.id)).toBe(1);
  });
});

// =================================================================================================
describe("funciones auth.* con membresia activa (CA-9, D9)", () => {
  const VALIDAR =
    "select sesion_id, usuario_id, tenant_activo, estudio_revocado, expira_absoluta from auth.sesion_validar($1::bytea)";
  const ROTAR = "select sesion_id, expira_absoluta from auth.sesion_rotar($1::bytea, $2::bytea, $3::uuid)";
  const LOGIN =
    "select sesion_id, expira_absoluta from auth.login_exito($1::bytea, $2::uuid, $3::text, $4::bytea, $5::uuid, $6::text, $7::bytea)";
  const validar = (t: Buffer) => exito(llamar(app, VALIDAR, [t]));
  const rotar = (t: Buffer, n: Buffer, tenant: string | null) => llamar(app, ROTAR, [t, n, tenant]);
  const login = (k: Buffer, u: { id: string; hash: string | null }, tok: Buffer, tenant: string | null) =>
    llamar(app, LOGIN, [k, u.id, u.hash, tok, tenant, null, null]);
  const ultimo = async (t: Buffer) => (await exito(llamar(app, "select auth.ultimo_estudio($1::bytea) as v", [t])))[0]?.v as string | null;
  const desactivar = (t: string, u: string) =>
    adm("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [t, u]);
  const reactivar = (t: string, u: string) =>
    adm("update membresia set desactivada_en = null where tenant_id = $1 and usuario_id = $2", [t, u]);
  const filaSesion = async (t: Buffer) => (await adm("select * from auth.sesion where token_hash = $1", [t]))[0];

  async function dosEstudios() {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const dx = await ea.miembro(x.id, "dueno"); // para que el estudio tenga Dueño
    const dy = await ea.miembro(y.id, "dueno");
    const u = await ea.cuenta();
    await ea.membresia(x.id, u.id, "contador");
    await ea.membresia(y.id, u.id, "contador");
    return { x, y, dx, dy, u };
  }

  it("sesion_validar: con la membresia del estudio activo desactivada devuelve estudio_revocado y deja el estudio en NULL", async () => {
    const { x, y, u } = await dosEstudios();
    const enX = await ea.esc.sesion(u.id, x.id);
    const enY = await ea.esc.sesion(u.id, y.id);
    expect((await validar(enX))[0]).toMatchObject({ tenant_activo: x.id, estudio_revocado: false });
    await desactivar(x.id, u.id);
    const r = await validar(enX);
    expect(r).toHaveLength(1);
    expect(r[0].tenant_activo).toBeNull();
    expect(r[0].estudio_revocado).toBe(true);
    expect((await filaSesion(enX)).tenant_activo).toBeNull();
    expect((await filaSesion(enX)).revocada_en).toBeNull(); // la sesion sigue viva, solo perdio el estudio
    // la sesion del MISMO usuario con otro estudio sigue (CA-9)
    expect((await validar(enY))[0]).toMatchObject({ tenant_activo: y.id, estudio_revocado: false });
  });

  it("sesion_validar: desactivar a un usuario no afecta a otro miembro del mismo estudio", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const u1 = await ea.miembro(x.id, "contador");
    const u2 = await ea.miembro(x.id, "contador");
    const s1 = await ea.esc.sesion(u1.id, x.id);
    const s2 = await ea.esc.sesion(u2.id, x.id);
    await desactivar(x.id, u1.id);
    expect((await validar(s1))[0].estudio_revocado).toBe(true);
    expect((await validar(s2))[0]).toMatchObject({ tenant_activo: x.id, estudio_revocado: false });
  });

  it("login_exito: rechaza el estudio con la membresia desactivada (sin crear sesion) y acepta el otro; reactivar devuelve el acceso", async () => {
    const { x, y, u } = await dosEstudios();
    await desactivar(x.id, u.id);
    const clave = ea.esc.clave(u.correo);
    const tokX = nuevoToken();
    expect(rechazada(await login(clave, u, tokX, x.id))).toBe(true);
    expect(await filaSesion(tokX)).toBeUndefined();
    const tokY = nuevoToken();
    const ok = await login(clave, u, tokY, y.id);
    expect(ok.ok && ok.rows.length).toBe(1);
    expect((await filaSesion(tokY)).tenant_activo).toBe(y.id);
    // D9 / RF-027: reactivar devuelve el acceso con su rol
    await reactivar(x.id, u.id);
    const tokX2 = nuevoToken();
    const ok2 = await login(clave, u, tokX2, x.id);
    expect(ok2.ok && ok2.rows.length).toBe(1);
  });

  it("sesion_rotar: no cambia a un estudio con la membresia desactivada; la sesion original sigue vigente; el otro estudio rota", async () => {
    const { x, y, u } = await dosEstudios();
    const base = await ea.esc.sesion(u.id, y.id);
    await desactivar(x.id, u.id);
    const nuevo = nuevoToken();
    expect(rechazada(await rotar(base, nuevo, x.id))).toBe(true);
    expect(await filaSesion(nuevo)).toBeUndefined();
    expect(await validar(base)).toHaveLength(1);
    const nuevo2 = nuevoToken();
    const ok = await rotar(base, nuevo2, y.id);
    expect(ok.ok && ok.rows.length).toBe(1);
    await reactivar(x.id, u.id);
    const nuevo3 = nuevoToken();
    const ok3 = await rotar(nuevo2, nuevo3, x.id);
    expect(ok3.ok && ok3.rows.length).toBe(1);
  });

  it("ultimo_estudio ignora el estudio con la membresia desactivada y vuelve a verlo al reactivar", async () => {
    const { x, y, u } = await dosEstudios();
    const sY = await ea.esc.sesion(u.id, y.id);
    const sX = await ea.esc.sesion(u.id, x.id);
    const sSin = await ea.esc.sesion(u.id, null);
    await adm("update auth.sesion set ultimo_uso = now() - interval '2 hours' where token_hash = $1", [sY]);
    await adm("update auth.sesion set ultimo_uso = now() - interval '1 hour' where token_hash = $1", [sX]);
    expect(await ultimo(sSin)).toBe(x.id);
    await desactivar(x.id, u.id);
    expect(await ultimo(sSin)).toBe(y.id);
    await reactivar(x.id, u.id);
    expect(await ultimo(sSin)).toBe(x.id);
  });

  it("las firmas siguen siendo las de 004 (CREATE OR REPLACE sin cambiar argumentos ni resultado)", async () => {
    const r = await adm(
      `select p.oid::regprocedure::text as firma from pg_proc p
        where p.pronamespace = to_regnamespace('auth')
          and p.proname in ('login_exito','sesion_validar','sesion_rotar','ultimo_estudio') order by 1`,
    );
    expect(r.map((f) => f.firma)).toEqual([
      "auth.login_exito(bytea,uuid,text,bytea,uuid,text,bytea)",
      "auth.sesion_rotar(bytea,bytea,uuid)",
      "auth.sesion_validar(bytea)",
      "auth.ultimo_estudio(bytea)",
    ]);
  });
});

// =================================================================================================
describe("auth.invitacion_vigente (D7: sin efectos)", () => {
  const VIGENTE = "select estudio_nombre, correo, rol, cuenta_existe from auth.invitacion_vigente($1::bytea)";
  const vigente = (h: Buffer) => exito(llamar(app, VIGENTE, [h]));
  const estado = async (id: string) =>
    (await adm("select aceptada_en, aceptada_por, revocada_en, vence_en, token_hash from invitacion where id = $1", [id]))[0];

  it("una invitacion viva devuelve estudio, correo, rol y cuenta_existe=false, y nada mas (ni token ni hash)", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, rol: "asistente" });
    const r = await vigente(inv.tokenHash);
    expect(r).toEqual([{ estudio_nombre: x.nombre, correo: inv.correo, rol: "asistente", cuenta_existe: false }]);
    expect(Object.keys(r[0]).sort()).toEqual(["correo", "cuenta_existe", "estudio_nombre", "rol"]);
  });

  it("cuenta_existe=true si el correo ya tiene cuenta en la plataforma, aunque no sea miembro de este estudio", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const cuenta = await ea.cuenta();
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, correo: cuenta.correo, rol: "lectura" });
    expect((await vigente(inv.tokenHash))[0]).toMatchObject({ correo: cuenta.correo, cuenta_existe: true });
  });

  it("consultar no consume ni modifica nada: dos consultas iguales, la fila intacta y sin usuario nuevo", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id });
    const antes = await estado(inv.id);
    const r1 = await vigente(inv.tokenHash);
    const r2 = await vigente(inv.tokenHash);
    expect(r1).toEqual(r2);
    expect(await estado(inv.id)).toEqual(antes);
    expect(await adm("select 1 from usuario where email = $1", [inv.correo])).toHaveLength(0);
  });

  it.each([
    ["aceptada", { aceptada: true }],
    ["revocada", { revocada: true }],
    ["vencida (vence_en <= now())", { vencida: true }],
  ] as const)("una invitacion %s devuelve cero filas", async (_n, o) => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, ...o });
    expect(await vigente(inv.tokenHash)).toHaveLength(0);
  });

  it("un token desconocido o alterado devuelve cero filas", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id });
    expect(await vigente(sha256(randomBytes(32)))).toHaveLength(0);
    const alterado = Buffer.from(inv.tokenHash);
    alterado[0] = alterado[0]! ^ 1;
    expect(await vigente(alterado)).toHaveLength(0);
    // el token en claro NO es el hash: mandarlo como si lo fuera no coincide
    expect(await vigente(inv.token)).toHaveLength(0);
  });

  it("vence exactamente en vence_en: una invitacion que vence en el futuro inmediato sigue viva, a partir de now() no", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id });
    await adm("update invitacion set vence_en = now() + interval '1 minute' where id = $1", [inv.id]);
    expect(await vigente(inv.tokenHash)).toHaveLength(1);
    await adm("update invitacion set vence_en = now() where id = $1", [inv.id]);
    expect(await vigente(inv.tokenHash)).toHaveLength(0);
  });
});

// =================================================================================================
describe("auth.invitacion_aceptar_nueva (CA-3: una transaccion, un solo uso)", () => {
  const NUEVA = "select auth.invitacion_aceptar_nueva($1::bytea, $2::text, $3::text) as v";
  const aceptar = (h: Buffer, nombre = "Persona Invitada", hash = hashFalso()) => llamar(app, NUEVA, [h, nombre, hash]);
  const valor = async (p: Promise<Awaited<ReturnType<typeof llamar>>>): Promise<string> => {
    const r = await p;
    if (!r.ok) throw new Error(`la funcion fallo (SQLSTATE ${r.code})`);
    return r.rows[0].v as string;
  };
  const usuarioPorCorreo = async (correo: string) => (await adm("select id, nombre from usuario where email = $1", [correo]))[0];
  const membresias = async (tenant: string, correo: string) =>
    adm(
      "select m.rol, m.desactivada_en from membresia m join usuario u on u.id = m.usuario_id where m.tenant_id = $1 and u.email = $2",
      [tenant, correo],
    );
  const credencial = async (usuarioId: string) =>
    (await adm("select hash from auth.usuario_contrasena where usuario_id = $1", [usuarioId]))[0]?.hash as string | undefined;
  const invitacion = async (id: string) => (await adm("select * from invitacion where id = $1", [id]))[0];

  it.each(["dueno", "admin", "contador", "asistente", "lectura"] as const)(
    "con un token vivo y correo sin cuenta crea usuario, credencial y membresia con el rol invitado (%s)",
    async (rol) => {
      const x = await ea.estudio();
      const d = await ea.miembro(x.id, "dueno");
      const inv = await ea.invitacion(x.id, { invitadoPor: d.id, rol });
      const hash = hashFalso();
      expect(await valor(aceptar(inv.tokenHash, "Nombre Nuevo", hash))).toBe("aceptada");
      const u = await usuarioPorCorreo(inv.correo);
      expect(u).toMatchObject({ nombre: "Nombre Nuevo" });
      expect(await credencial(u.id)).toBe(hash);
      expect(await membresias(x.id, inv.correo)).toEqual([{ rol, desactivada_en: null }]);
      const f = await invitacion(inv.id);
      expect(f.aceptada_por).toBe(u.id);
      expect(f.aceptada_en).toBeInstanceOf(Date);
      expect(f.revocada_en).toBeNull();
    },
  );

  it("es todo o nada: si la credencial no es valida no queda usuario, membresia ni invitacion consumida", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id });
    const r = await aceptar(inv.tokenHash, "Nombre", "no-es-un-hash-argon2id");
    expect(r.ok && r.rows[0].v === "aceptada").toBe(false);
    expect(await usuarioPorCorreo(inv.correo)).toBeUndefined();
    expect(await membresias(x.id, inv.correo)).toHaveLength(0);
    expect((await invitacion(inv.id)).aceptada_en).toBeNull();
    // y sigue viva para un intento correcto
    expect(await valor(aceptar(inv.tokenHash))).toBe("aceptada");
  });

  it("segundo uso del mismo token: 'invalida' y sin cambios", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id });
    expect(await valor(aceptar(inv.tokenHash))).toBe("aceptada");
    const u = await usuarioPorCorreo(inv.correo);
    const hashAntes = await credencial(u.id);
    expect(await valor(aceptar(inv.tokenHash, "Otro Nombre", hashFalso()))).toBe("invalida");
    expect(await credencial(u.id)).toBe(hashAntes);
    expect((await usuarioPorCorreo(inv.correo)).nombre).toBe("Persona Invitada");
    expect(await membresias(x.id, inv.correo)).toHaveLength(1);
  });

  it.each([
    ["revocada", { revocada: true }],
    ["vencida", { vencida: true }],
    ["ya aceptada", { aceptada: true }],
  ] as const)("una invitacion %s da 'invalida' y no crea nada", async (_n, o) => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, ...o });
    expect(await valor(aceptar(inv.tokenHash))).toBe("invalida");
    expect(await usuarioPorCorreo(inv.correo)).toBeUndefined();
    expect(await membresias(x.id, inv.correo)).toHaveLength(0);
  });

  it("un token desconocido o alterado da 'invalida' (la misma respuesta que los demas casos)", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id });
    const alterado = Buffer.from(inv.tokenHash);
    alterado[31] = alterado[31]! ^ 0x80;
    expect(await valor(aceptar(sha256(randomBytes(32))))).toBe("invalida");
    expect(await valor(aceptar(alterado))).toBe("invalida");
    expect(await usuarioPorCorreo(inv.correo)).toBeUndefined();
  });

  it("si el correo ya tiene cuenta: 'cuenta_existe', no consume la invitacion y NO cambia su contrasena (D15)", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const cuenta = await ea.cuenta();
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, correo: cuenta.correo, rol: "contador" });
    const antes = await credencial(cuenta.id);
    expect(await valor(aceptar(inv.tokenHash, "Suplantador", hashFalso()))).toBe("cuenta_existe");
    expect(await credencial(cuenta.id)).toBe(antes);
    expect(await membresias(x.id, cuenta.correo)).toHaveLength(0);
    const f = await invitacion(inv.id);
    expect(f.aceptada_en).toBeNull();
    expect(f.aceptada_por).toBeNull();
    expect((await adm("select nombre from usuario where id = $1", [cuenta.id]))[0].nombre).not.toBe("Suplantador");
  });

  it("5 aceptaciones concurrentes del mismo token: exactamente una 'aceptada', un solo usuario y una sola membresia", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, rol: "admin" });
    const r = await Promise.all(Array.from({ length: 5 }, () => aceptar(inv.tokenHash)));
    const aceptadas = r.filter((q) => q.ok && q.rows[0].v === "aceptada");
    expect(aceptadas).toHaveLength(1);
    for (const q of r.filter((z) => !aceptadas.includes(z))) {
      // las demas fallan: 'invalida' o 'cuenta_existe' (si ya ven el usuario creado) o un error de PG, nunca otra 'aceptada'
      expect(q.ok ? q.rows[0].v : "error").toMatch(/^(invalida|cuenta_existe|error)$/);
    }
    expect(await adm("select 1 from usuario where email = $1", [inv.correo])).toHaveLength(1);
    expect(await membresias(x.id, inv.correo)).toEqual([{ rol: "admin", desactivada_en: null }]);
  });

  it("dos invitaciones de estudios distintos al mismo correo nuevo, a la vez: una gana, la otra no crea cuenta y su token sigue vivo", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const dx = await ea.miembro(x.id, "dueno");
    const dy = await ea.miembro(y.id, "dueno");
    const correo = ea.esc.correoNuevo();
    const ix = await ea.invitacion(x.id, { invitadoPor: dx.id, correo });
    const iy = await ea.invitacion(y.id, { invitadoPor: dy.id, correo });
    const r = await Promise.all([aceptar(ix.tokenHash), aceptar(iy.tokenHash)]);
    const ganadoras = r.filter((q) => q.ok && q.rows[0].v === "aceptada");
    expect(ganadoras).toHaveLength(1);
    expect(await adm("select 1 from usuario where email = $1", [correo])).toHaveLength(1);
    const perdedora = r[0] === ganadoras[0] ? iy : ix;
    expect((await invitacion(perdedora.id)).aceptada_en).toBeNull();
    const vivo = await exito(
      llamar(app, "select correo from auth.invitacion_vigente($1::bytea)", [perdedora.tokenHash]),
    );
    expect(vivo).toHaveLength(1);
  });
});

// =================================================================================================
describe("auth.invitacion_aceptar_existente (D15: con la sesion del titular)", () => {
  const EXISTENTE =
    "select tenant_id, estudio_nombre from auth.invitacion_aceptar_existente($1::bytea, $2::bytea)";
  const aceptar = (h: Buffer, sesion: Buffer) => llamar(app, EXISTENTE, [h, sesion]);
  const membresia = async (t: string, u: string) =>
    adm("select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [t, u]);
  const invitacion = async (id: string) => (await adm("select aceptada_en, aceptada_por from invitacion where id = $1", [id]))[0];
  const credencial = async (u: string) => (await adm("select hash from auth.usuario_contrasena where usuario_id = $1", [u]))[0]?.hash;

  async function escenario(o: { rol?: "dueno" | "admin" | "contador" | "asistente" | "lectura" } = {}) {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const u = await ea.cuenta();
    const sesion = await ea.esc.sesion(u.id, null);
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, correo: u.correo, rol: o.rol ?? "contador" });
    return { x, d, u, sesion, inv };
  }

  it("con la sesion viva del titular y el correo exacto crea la membresia con el rol invitado y devuelve el estudio", async () => {
    const { x, u, sesion, inv } = await escenario({ rol: "asistente" });
    const hashAntes = await credencial(u.id);
    const r = await aceptar(inv.tokenHash, sesion);
    expect(r).toEqual({ ok: true, rows: [{ tenant_id: x.id, estudio_nombre: x.nombre }] });
    expect(await membresia(x.id, u.id)).toEqual([{ rol: "asistente", desactivada_en: null }]);
    const f = await invitacion(inv.id);
    expect(f.aceptada_por).toBe(u.id);
    expect(f.aceptada_en).toBeInstanceOf(Date);
    expect(await credencial(u.id)).toBe(hashAntes); // nunca se toca la contrasena
  });

  it("otra cuenta (correo distinto) con SU sesion viva no puede usar el token: cero filas y sin efectos", async () => {
    const { x, sesion: _s, inv } = await escenario();
    const intruso = await ea.cuenta();
    const sesionIntruso = await ea.esc.sesion(intruso.id, null);
    const r = await aceptar(inv.tokenHash, sesionIntruso);
    expect(rechazada(r)).toBe(true);
    expect(await membresia(x.id, intruso.id)).toHaveLength(0);
    expect((await invitacion(inv.id)).aceptada_en).toBeNull();
  });

  it("el correo debe ser EXACTAMENTE el de la invitacion: un comodin LIKE no sirve", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const u = await ea.cuenta();
    const sesion = await ea.esc.sesion(u.id, null);
    const comodin = `${u.correo.slice(0, 3)}%${u.correo.slice(u.correo.indexOf("@"))}`;
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, correo: comodin });
    expect(rechazada(await aceptar(inv.tokenHash, sesion))).toBe(true);
    expect(await membresia(x.id, u.id)).toHaveLength(0);
  });

  it.each([
    ["sesion revocada", async (e: Awaited<ReturnType<typeof escenario>>) => adm("update auth.sesion set revocada_en = now(), motivo = 'logout' where token_hash = $1", [e.sesion])],
    ["sesion con mas de 12 h", async (e: Awaited<ReturnType<typeof escenario>>) => adm("update auth.sesion set expira_absoluta = now() - interval '1 second' where token_hash = $1", [e.sesion])],
    ["sesion inactiva mas de 2 h", async (e: Awaited<ReturnType<typeof escenario>>) => adm("update auth.sesion set ultimo_uso = now() - interval '121 minutes' where token_hash = $1", [e.sesion])],
    ["invitacion revocada", async (e: Awaited<ReturnType<typeof escenario>>) => adm("update invitacion set revocada_en = now() where id = $1", [e.inv.id])],
    ["invitacion vencida", async (e: Awaited<ReturnType<typeof escenario>>) => adm("update invitacion set vence_en = now() - interval '1 second' where id = $1", [e.inv.id])],
    ["invitacion ya aceptada", async (e: Awaited<ReturnType<typeof escenario>>) => adm("update invitacion set aceptada_en = now() where id = $1", [e.inv.id])],
  ])("%s: cero filas y sin efectos", async (_n, estropear) => {
    const e = await escenario();
    await estropear(e);
    expect(rechazada(await aceptar(e.inv.tokenHash, e.sesion))).toBe(true);
    expect(await membresia(e.x.id, e.u.id)).toHaveLength(0);
  });

  it("token o sesion desconocidos: cero filas", async () => {
    const { sesion, inv } = await escenario();
    expect(rechazada(await aceptar(sha256(randomBytes(32)), sesion))).toBe(true);
    expect(rechazada(await aceptar(inv.tokenHash, nuevoToken()))).toBe(true);
  });

  it("quien ya es miembro (activo o desactivado) no puede aceptar: cero filas y su membresia no cambia", async () => {
    for (const desactivada of [false, true]) {
      const { x, u, sesion, inv } = await escenario({ rol: "dueno" });
      await ea.membresia(x.id, u.id, "lectura", { desactivada });
      expect(rechazada(await aceptar(inv.tokenHash, sesion))).toBe(true);
      const m = await membresia(x.id, u.id);
      expect(m).toHaveLength(1);
      expect(m[0].rol).toBe("lectura"); // la invitacion de `dueno` NO escala el rol existente
      expect((await invitacion(inv.id)).aceptada_en).toBeNull();
    }
  });

  it("dos aceptaciones concurrentes del mismo token y sesion: una sola fila y una sola membresia", async () => {
    const { x, u, sesion, inv } = await escenario();
    const r = await Promise.all([aceptar(inv.tokenHash, sesion), aceptar(inv.tokenHash, sesion), aceptar(inv.tokenHash, sesion)]);
    expect(r.filter((q) => q.ok && q.rows.length === 1)).toHaveLength(1);
    expect(await membresia(x.id, u.id)).toHaveLength(1);
  });
});
