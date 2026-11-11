// Spec 006 (T13a, rojo): decisiones D14 y D15 y hallazgos de la ronda adversarial (T12a/T12b) que los `*.adv*.spec.ts` no
// cubren, en la BD. Los implementa T13b en la migracion 0025_planes_ronda1.sql (plan.md, "Ajustes de la ronda adversarial").
//
// Contrato que fija (T13b):
//   auth.prueba_origen(usuario_id uuid PK -> usuario ON DELETE CASCADE, tenant_id uuid NULL -> tenant ON DELETE SET NULL,
//       creada_en timestamptz NOT NULL): dueño contapp_migrator, RLS ENABLE+FORCE, grants SOLO a contapp_auth, el backend no la ve.
//   auth.registro_confirmar_nueva: ademas de lo de siempre inserta la fila de prueba_origen del usuario nuevo (con su estudio).
//   auth.registro_confirmar_existente(token_hash, token_hash_sesion) -> (tenant_id, estudio_nombre, con_prueba boolean).
//       `INSERT ... ON CONFLICT (usuario_id) DO NOTHING` en prueba_origen: si inserta, crea la suscripcion `prueba` y
//       con_prueba = true; si no, crea tenant y membresia `dueno` SIN suscripcion y con_prueba = false.
//   auth.suscripcion_asignar sobre un estudio SIN suscripcion la crea (`activa`, prueba_vence_en NULL); revierte la ratificacion
//       de T1 (D14). Sigue rechazando plan inactivo, extra sobre el tope y estudio inexistente.
//   auth.registro_pendiente.invalidada_en timestamptz NULL: registro_crear la fija en los pendientes anteriores del correo;
//       registro_vigente / registro_confirmar_* no aceptan un pendiente invalidado.
//   plan_crear / plan_editar rechazan NaN en los tres precios; `plan` lo impide con CHECK (Infinity ya lo rechaza PG).
//   FUNCIONES_AUTH sigue en 28 (DROP + CREATE de registro_confirmar_existente, sin sobrecargas).
// Cada prueba crea sus cuentas, estudios y pendientes (EscenarioPlanes) y los borra al final.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirAdmin,
  abrirApp,
  FUNCIONES_AUTH,
  hashFalso,
  llamar,
  type Llamada,
} from "./auth-soporte";
import { EscenarioPlanes, tokenHashNuevo } from "./planes-soporte";
import { intentarRaw } from "./soporte";

let app: Pool;
let admin: Pool;
let ep: EscenarioPlanes;

beforeAll(() => {
  app = abrirApp(30);
  admin = abrirAdmin(6);
  ep = new EscenarioPlanes(admin);
});
afterAll(async () => {
  await ep?.limpiar();
  await app?.end();
  await admin?.end();
});

const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
const FALTA_ESQUEMA = ["42883", "42P01", "42703", "3F000"];
const exitosa = (r: Llamada) => {
  if (!r.ok) throw new Error(`la funcion fallo (SQLSTATE ${r.code}): ${r.message}`);
  return r.rows;
};
/** Rechazo valido: error de la funcion (no de esquema inexistente) o cero filas / false / 'invalida'. */
const rechazada = (r: Llamada): boolean => {
  if (!r.ok && FALTA_ESQUEMA.includes(r.code)) throw new Error(`falta el esquema o la funcion (SQLSTATE ${r.code})`);
  return !r.ok || r.rows.length === 0 || r.rows[0]?.v === false || r.rows[0]?.v === "invalida";
};

const SQL = {
  crear: "select auth.registro_crear($1::text, $2::text, $3::text, $4::text, $5::bytea) as v",
  vigente: "select nombre_estudio, correo, cuenta_existe from auth.registro_vigente($1::bytea)",
  nueva: "select auth.registro_confirmar_nueva($1::bytea, $2::text) as v",
  existente: "select tenant_id, estudio_nombre, con_prueba from auth.registro_confirmar_existente($1::bytea, $2::bytea)",
  planCrear:
    "select * from auth.plan_crear($1::bytea, $2::text, $3::text, $4::numeric, $5::numeric, $6::int, $7::int, $8::numeric, $9::int, $10::int, $11::jsonb, $12::boolean)",
  planEditar:
    "select * from auth.plan_editar($1::bytea, $2::uuid, $3::text, $4::text, $5::numeric, $6::numeric, $7::int, $8::int, $9::numeric, $10::int, $11::int, $12::jsonb, $13::boolean)",
  estudios: "select * from auth.estudios_listar($1::bytea)",
  asignar: "select * from auth.suscripcion_asignar($1::bytea, $2::uuid, $3::uuid, $4::int)",
  limite: "select auth.limite_consumir($1::text, $2::text) as v",
};

/** Pendiente insertado directamente (varios vivos para el mismo correo, que `registro_crear` no permite). */
async function pendienteDirecto(correo: string) {
  const hash = tokenHashNuevo();
  const estudio = ep.nombreEstudio();
  await adm(
    `insert into auth.registro_pendiente (correo, nombre_estudio, ruc_estudio, nombre_usuario, token_hash)
     values ($1, $2, null, 'Dueña de Prueba', $3)`,
    [correo, estudio, hash],
  );
  return { hash, estudio };
}
const confirmarExistente = (h: Buffer, sesion: Buffer) => llamar(app, SQL.existente, [h, sesion]);
const recordar = (filas: Array<{ tenant_id: string }>) => {
  for (const f of filas) if (!ep.ea.estudios.includes(f.tenant_id)) ep.ea.estudios.push(f.tenant_id);
};
const susDe = (tenantId: string) =>
  adm(
    `select p.codigo, s.estado, s.prueba_vence_en, s.rucs_extra_contratados
       from suscripcion s join plan p on p.id = s.plan_id where s.tenant_id = $1`,
    [tenantId],
  );
const origenDe = (usuarioId: string) =>
  adm("select usuario_id, tenant_id, creada_en from auth.prueba_origen where usuario_id = $1", [usuarioId]);
const duenoDe = (tenantId: string, usuarioId: string) =>
  adm(
    "select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2",
    [tenantId, usuarioId],
  );

// =================================================================================================
describe("D14 · auth.prueba_origen: una prueba por cuenta, en la BD", () => {
  it("existe con usuario_id (PK, CASCADE), tenant_id (NULL, SET NULL) y creada_en; dueño contapp_migrator, RLS ENABLE+FORCE", async () => {
    const cols = await adm(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'auth' and table_name = 'prueba_origen' order by column_name`,
    );
    expect(cols).toEqual([
      { column_name: "creada_en", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "tenant_id", data_type: "uuid", is_nullable: "YES" },
      { column_name: "usuario_id", data_type: "uuid", is_nullable: "NO" },
    ]);
    const t = (
      await adm(
        `select c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) dueno
           from pg_class c where c.oid = to_regclass('auth.prueba_origen')`,
      )
    )[0];
    expect(t).toEqual({ relrowsecurity: true, relforcerowsecurity: true, dueno: "contapp_migrator" });
    const pk = await adm(
      `select a.attname from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
        where k.conrelid = to_regclass('auth.prueba_origen') and k.contype = 'p'`,
    );
    expect(pk).toEqual([{ attname: "usuario_id" }]);
    const fks = await adm(
      `select a.attname, k.confdeltype, k.confrelid::regclass::text as destino
         from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
        where k.conrelid = to_regclass('auth.prueba_origen') and k.contype = 'f' order by a.attname`,
    );
    expect(fks).toEqual([
      { attname: "tenant_id", confdeltype: "n", destino: "tenant" },
      { attname: "usuario_id", confdeltype: "c", destino: "usuario" },
    ]);
  });

  it("los unicos privilegios son los de contapp_auth (ACL de tabla) y su politica es solo para contapp_auth", async () => {
    const quien = await adm(
      `select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as quien
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass('auth.prueba_origen') and a.grantee <> c.relowner`,
    );
    expect(quien.map((x) => x.quien)).toEqual(["contapp_auth"]);
    const pol = await adm(
      "select policyname, roles::text[] as roles from pg_policies where schemaname = 'auth' and tablename = 'prueba_origen'",
    );
    expect(pol.length).toBeGreaterThan(0);
    for (const p of pol) expect(p.roles, p.policyname).toEqual(["contapp_auth"]);
  });

  it.each(["contapp_backend", "contapp_worker", "contapp_platform", "contapp_app"])(
    "%s no tiene ningun privilegio sobre la tabla ni sobre sus columnas (42501)",
    async (rol) => {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const v = (await adm("select has_table_privilege($1, 'auth.prueba_origen', $2) as v", [rol, p]))[0].v;
        expect(v, `${rol} ${p}`).toBe(false);
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        const v = (await adm("select has_any_column_privilege($1, 'auth.prueba_origen', $2) as v", [rol, p]))[0].v;
        expect(v, `${rol} ${p} (columna)`).toBe(false);
      }
      // Ajuste de 006 (T13b): contapp_app no puede SET ROLE a contapp_platform; el rol se asume desde la conexión administrativa
      // (como auth.spec.ts, auth.limite_consumir).
      const r = await intentarRaw(admin, rol, "select usuario_id from auth.prueba_origen");
      expect(r.ok ? "ok" : r.code).toBe("42501");
    },
  );

  it("borrar al usuario borra su fila (CASCADE) y borrar el estudio la deja con tenant_id NULL (SET NULL)", async () => {
    const cuenta = await ep.cuentaRegistro();
    const sesion = await ep.ea.esc.sesion(cuenta.id, null);
    const p = await pendienteDirecto(cuenta.correo);
    const [f] = exitosa(await confirmarExistente(p.hash, sesion));
    recordar([f]);
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("alter table membresia disable trigger user");
      await c.query("delete from suscripcion where tenant_id = $1", [f.tenant_id]);
      await c.query("delete from membresia where tenant_id = $1", [f.tenant_id]);
      // 017: notificacion, plan_aviso y auditoria (FK a tenant; auditoria es inmutable) se borran con `replica`; luego se vuelve a
      // `origin` porque esta prueba comprueba el SET NULL de la FK de auth.prueba_origen. Un SAVEPOINT tolera que falten (rojo).
      for (const tabla of ["notificacion", "plan_aviso", "auditoria"]) {
        await c.query("savepoint limpieza");
        try {
          await c.query("set local session_replication_role = replica");
          await c.query(`delete from ${tabla} where tenant_id = $1`, [f.tenant_id]);
          await c.query("release savepoint limpieza");
        } catch {
          await c.query("rollback to savepoint limpieza");
        }
        await c.query("set local session_replication_role = origin");
      }
      await c.query("delete from tenant where id = $1", [f.tenant_id]);
      const tras = (await c.query("select usuario_id, tenant_id from auth.prueba_origen where usuario_id = $1", [cuenta.id]))
        .rows;
      expect(tras).toEqual([{ usuario_id: cuenta.id, tenant_id: null }]);
      await c.query("delete from auth.sesion where usuario_id = $1", [cuenta.id]);
      await c.query("delete from auth.usuario_contrasena where usuario_id = $1", [cuenta.id]);
      await c.query("delete from membresia where usuario_id = $1", [cuenta.id]);
      await c.query("delete from usuario where id = $1", [cuenta.id]);
      expect((await c.query("select 1 from auth.prueba_origen where usuario_id = $1", [cuenta.id])).rowCount).toBe(0);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});

// =================================================================================================
describe("D14 · registro_confirmar_nueva y registro_confirmar_existente reparten la prueba", () => {
  it("registro_confirmar_nueva deja registrada la prueba del usuario nuevo (con su estudio)", async () => {
    const correo = ep.correoRegistro();
    const hash = tokenHashNuevo();
    const estudio = ep.nombreEstudio();
    expect(exitosa(await llamar(app, SQL.crear, [correo, estudio, null, "Dueña de Prueba", hash]))).toHaveLength(1);
    expect(exitosa(await llamar(app, SQL.nueva, [hash, hashFalso()]))[0].v).toBe("creado");
    const [u] = await adm("select id from usuario where email = $1", [correo]);
    const [t] = await adm("select id from tenant where nombre = $1", [estudio]);
    const o = await origenDe(u.id);
    expect(o).toHaveLength(1);
    expect(o[0].tenant_id).toBe(t.id);
    expect((await susDe(t.id))[0]).toMatchObject({ codigo: "prueba", estado: "prueba" });
  });

  it("cuenta existente, 1.º estudio: con_prueba = true, suscripcion Prueba a 14 dias y fila en prueba_origen", async () => {
    const cuenta = await ep.cuentaRegistro();
    const sesion = await ep.ea.esc.sesion(cuenta.id, null);
    const p = await pendienteDirecto(cuenta.correo);
    const filas = exitosa(await confirmarExistente(p.hash, sesion));
    recordar(filas);
    expect(filas).toHaveLength(1);
    expect(filas[0].con_prueba).toBe(true);
    const sus = await susDe(filas[0].tenant_id);
    expect(sus).toHaveLength(1);
    expect(sus[0]).toMatchObject({ codigo: "prueba", estado: "prueba" });
    const origen = await origenDe(cuenta.id);
    expect(origen).toHaveLength(1);
    expect(origen[0].tenant_id).toBe(filas[0].tenant_id);
  });

  it("2.º y 3.er estudio de la misma cuenta: con_prueba = false, Dueño y estudio creados, SIN suscripcion; prueba_origen no cambia", async () => {
    const cuenta = await ep.cuentaRegistro();
    const sesion = await ep.ea.esc.sesion(cuenta.id, null);
    const primero = exitosa(await confirmarExistente((await pendienteDirecto(cuenta.correo)).hash, sesion));
    recordar(primero);
    const antes = await origenDe(cuenta.id);
    for (let i = 2; i <= 3; i++) {
      const p = await pendienteDirecto(cuenta.correo);
      const filas = exitosa(await confirmarExistente(p.hash, sesion));
      recordar(filas);
      expect(filas, `estudio ${i}`).toHaveLength(1);
      expect(filas[0].con_prueba, `estudio ${i}`).toBe(false);
      expect(filas[0].estudio_nombre).toBe(p.estudio);
      expect(await duenoDe(filas[0].tenant_id, cuenta.id), `estudio ${i}`).toEqual([{ rol: "dueno", desactivada_en: null }]);
      expect(await susDe(filas[0].tenant_id), `estudio ${i}: sin suscripcion`).toEqual([]);
      // el enlace se consumio como siempre
      expect((await adm("select consumida_en from auth.registro_pendiente where token_hash = $1", [p.hash]))[0].consumida_en)
        .not.toBeNull();
    }
    expect(await origenDe(cuenta.id)).toEqual(antes);
    expect((await susDe(primero[0].tenant_id))[0]).toMatchObject({ codigo: "prueba", estado: "prueba" });
  });

  it("una cuenta creada por registro_confirmar_nueva ya uso su prueba: su siguiente estudio nace sin suscripcion", async () => {
    const correo = ep.correoRegistro();
    const h1 = tokenHashNuevo();
    exitosa(await llamar(app, SQL.crear, [correo, ep.nombreEstudio(), null, "Dueña de Prueba", h1]));
    expect(exitosa(await llamar(app, SQL.nueva, [h1, hashFalso()]))[0].v).toBe("creado");
    const [u] = await adm("select id from usuario where email = $1", [correo]);
    const sesion = await ep.ea.esc.sesion(u.id, null);
    const p = await pendienteDirecto(correo);
    const filas = exitosa(await confirmarExistente(p.hash, sesion));
    recordar(filas);
    expect(filas[0].con_prueba).toBe(false);
    expect(await susDe(filas[0].tenant_id)).toEqual([]);
    expect(await duenoDe(filas[0].tenant_id, u.id)).toEqual([{ rol: "dueno", desactivada_en: null }]);
  });

  it.each([5, 5, 5])(
    "5 confirmaciones simultaneas de la misma cuenta con pendientes distintos (ronda %#): exactamente 1 con Prueba y 5 estudios",
    async (n) => {
      const cuenta = await ep.cuentaRegistro();
      const sesion = await ep.ea.esc.sesion(cuenta.id, null);
      const pendientes = [];
      for (let i = 0; i < n; i++) pendientes.push(await pendienteDirecto(cuenta.correo));
      const rs = await Promise.all(pendientes.map((p) => confirmarExistente(p.hash, sesion)));
      const filas = rs.map(exitosa).flat();
      recordar(filas);
      expect(filas).toHaveLength(n);
      expect(new Set(filas.map((f) => f.tenant_id)).size).toBe(n);
      expect(filas.filter((f) => f.con_prueba === true)).toHaveLength(1);
      expect(filas.filter((f) => f.con_prueba === false)).toHaveLength(n - 1);
      let conSus = 0;
      for (const f of filas) {
        const s = await susDe(f.tenant_id);
        if (s.length > 0) {
          conSus++;
          expect(f.con_prueba).toBe(true);
          expect(s[0]).toMatchObject({ codigo: "prueba", estado: "prueba" });
        }
        expect(await duenoDe(f.tenant_id, cuenta.id)).toEqual([{ rol: "dueno", desactivada_en: null }]);
      }
      expect(conSus).toBe(1);
      expect(await origenDe(cuenta.id)).toHaveLength(1);
    },
  );
});

// =================================================================================================
describe("D14 · suscripcion_asignar sobre un estudio sin suscripcion la crea (revierte la ratificacion de T1)", () => {
  let adminMemo: Promise<{ usuario: { id: string }; sesion: Buffer }> | undefined;
  const comoAdmin = () => (adminMemo ??= ep.administrador());
  const asignar = async (tenantId: string, planId: string, extra: number, sesion?: Buffer) =>
    llamar(app, SQL.asignar, [sesion ?? (await comoAdmin()).sesion, tenantId, planId, extra]);

  it("crea una sola fila `activa`, sin vencimiento de prueba, con el plan y los RUCs adicionales pedidos", async () => {
    const p = await ep.plan({ maxRucs: 20, maxRucsExtra: 4 });
    const sin = await ep.ea.estudio();
    expect(await susDe(sin.id)).toEqual([]);
    const r = exitosa(await asignar(sin.id, p.id, 3));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      tenant_id: sin.id,
      plan_id: p.id,
      plan_codigo: p.codigo,
      estado: "activa",
      rucs_extra_contratados: 3,
    });
    const s = await adm("select estado, prueba_vence_en, rucs_extra_contratados from suscripcion where tenant_id = $1", [sin.id]);
    expect(s).toEqual([{ estado: "activa", prueba_vence_en: null, rucs_extra_contratados: 3 }]);
  });

  it("una segunda asignacion actualiza la misma fila (nunca hay dos por estudio)", async () => {
    const p = await ep.plan({ maxRucs: 20, maxRucsExtra: 4 });
    const q = await ep.plan({ maxRucs: 50, maxRucsExtra: 10 });
    const sin = await ep.ea.estudio();
    exitosa(await asignar(sin.id, p.id, 1));
    exitosa(await asignar(sin.id, q.id, 5));
    const s = await adm("select plan_id, rucs_extra_contratados from suscripcion where tenant_id = $1", [sin.id]);
    expect(s).toEqual([{ plan_id: q.id, rucs_extra_contratados: 5 }]);
  });

  it("estudios_listar lo muestra con plan_codigo y estado nulos (antes) y con el plan (despues); no falla", async () => {
    const p = await ep.plan();
    const sin = await ep.ea.estudio();
    const antes = exitosa(await llamar(app, SQL.estudios, [(await comoAdmin()).sesion])).find((x) => x.id === sin.id);
    expect(antes).toEqual({ id: sin.id, nombre: sin.nombre, plan_codigo: null, plan_nombre: null, estado: null });
    exitosa(await asignar(sin.id, p.id, 0));
    const despues = exitosa(await llamar(app, SQL.estudios, [(await comoAdmin()).sesion])).find((x) => x.id === sin.id);
    expect(despues).toMatchObject({ id: sin.id, plan_codigo: p.codigo, estado: "activa" });
  });

  it("5 asignaciones simultaneas sobre el mismo estudio sin suscripcion: todas terminan bien y queda UNA fila", async () => {
    const planes = [];
    for (let i = 0; i < 5; i++) planes.push(await ep.plan({ maxRucs: 20, maxRucsExtra: 4 }));
    const sin = await ep.ea.estudio();
    const sesion = (await comoAdmin()).sesion;
    const rs = await Promise.all(planes.map((p, i) => asignar(sin.id, p.id, i % 3, sesion)));
    for (const r of rs) expect(r.ok, JSON.stringify(r)).toBe(true);
    const filas = await adm("select plan_id, estado from suscripcion where tenant_id = $1", [sin.id]);
    expect(filas).toHaveLength(1);
    expect(planes.map((p) => p.id)).toContain(filas[0].plan_id);
    expect(filas[0].estado).toBe("activa");
  });

  it("las validaciones siguen y no crean fila: plan inactivo, extra sobre el tope, plan inexistente y estudio inexistente", async () => {
    const inactivo = await ep.plan({ activo: false });
    const corto = await ep.plan({ maxRucs: 10, maxRucsExtra: 2 });
    const bueno = await ep.plan();
    const sin = await ep.ea.estudio();
    expect(rechazada(await asignar(sin.id, inactivo.id, 0))).toBe(true);
    expect(rechazada(await asignar(sin.id, corto.id, 3))).toBe(true);
    expect(rechazada(await asignar(sin.id, "00000000-0000-7000-8000-000000000000", 0))).toBe(true);
    expect(await susDe(sin.id)).toEqual([]);
    const fantasma = "00000000-0000-7000-8000-0000000000ff";
    expect(rechazada(await asignar(fantasma, bueno.id, 0))).toBe(true);
    expect(await adm("select 1 from suscripcion where tenant_id = $1", [fantasma])).toHaveLength(0);
  });

  it("sin sesion de super-admin (un Dueño del propio estudio o una sesion ajena) no se crea nada", async () => {
    const p = await ep.plan();
    const sin = await ep.ea.estudio();
    const dueno = await ep.ea.miembro(sin.id, "dueno");
    const sesionDueno = await ep.ea.esc.sesion(dueno.id, sin.id);
    expect(rechazada(await asignar(sin.id, p.id, 0, sesionDueno))).toBe(true);
    expect(rechazada(await asignar(sin.id, p.id, 0, tokenHashNuevo()))).toBe(true);
    expect(await susDe(sin.id)).toEqual([]);
  });
});

// =================================================================================================
describe("b1 · invalidada_en: un pendiente invalidado no se confirma", () => {
  const vigente = (h: Buffer) => llamar(app, SQL.vigente, [h]);

  it("registro_crear fija invalidada_en en los pendientes anteriores del correo y deja el nuevo con NULL", async () => {
    const correo = ep.correoRegistro();
    const h1 = tokenHashNuevo();
    const h2 = tokenHashNuevo();
    exitosa(await llamar(app, SQL.crear, [correo, ep.nombreEstudio(), null, "Dueña de Prueba", h1]));
    expect((await adm("select invalidada_en from auth.registro_pendiente where token_hash = $1", [h1]))[0].invalidada_en)
      .toBeNull();
    exitosa(await llamar(app, SQL.crear, [correo, ep.nombreEstudio(), null, "Dueña de Prueba", h2]));
    const [viejo] = await adm(
      "select invalidada_en, consumida_en, creada_en from auth.registro_pendiente where token_hash = $1",
      [h1],
    );
    expect(viejo.invalidada_en).toBeInstanceOf(Date);
    expect(viejo.consumida_en).toBeNull();
    expect(viejo.invalidada_en.getTime()).toBeGreaterThanOrEqual(viejo.creada_en.getTime());
    expect((await adm("select invalidada_en from auth.registro_pendiente where token_hash = $1", [h2]))[0].invalidada_en)
      .toBeNull();
    expect(exitosa(await vigente(h1))).toEqual([]);
    expect(exitosa(await vigente(h2))).toHaveLength(1);
  });

  it("un pendiente con invalidada_en fijado (vence_en futuro, sin consumir) no es vigente ni se confirma por ninguna via", async () => {
    const cuenta = await ep.cuentaRegistro();
    const sesion = await ep.ea.esc.sesion(cuenta.id, null);
    const viejoExistente = await pendienteDirecto(cuenta.correo);
    const nuevo = await pendienteDirecto(ep.correoRegistro());
    await adm("update auth.registro_pendiente set invalidada_en = now() where token_hash = any($1::bytea[])", [
      [viejoExistente.hash, nuevo.hash],
    ]);
    expect(exitosa(await vigente(nuevo.hash))).toEqual([]);
    expect(exitosa(await vigente(viejoExistente.hash))).toEqual([]);
    expect(exitosa(await llamar(app, SQL.nueva, [nuevo.hash, hashFalso()]))[0].v).toBe("invalida");
    expect(exitosa(await confirmarExistente(viejoExistente.hash, sesion))).toEqual([]);
    expect(await adm("select 1 from usuario where email = (select correo from auth.registro_pendiente where token_hash = $1)", [nuevo.hash]))
      .toHaveLength(0);
    expect(await adm("select 1 from membresia where usuario_id = $1", [cuenta.id])).toHaveLength(0);
    expect(
      (await adm("select consumida_en from auth.registro_pendiente where token_hash = $1", [nuevo.hash]))[0].consumida_en,
    ).toBeNull();
  });

  it("b5 · registro_crear con un dato que viola un CHECK (carácter de control en el nombre) falla con 23514, exista o no la cuenta, y no invalida el enlace previo", async () => {
    const cuenta = await ep.cuentaRegistro();
    const sin = ep.correoRegistro();
    const previo = tokenHashNuevo();
    exitosa(await llamar(app, SQL.crear, [cuenta.correo, ep.nombreEstudio(), null, "Dueña de Prueba", previo]));
    const malo = "Titular\u0007Prueba"; // BEL: el CHECK lo rechaza por rango de código, sin depender de la versión de Unicode de PG
    const a = await llamar(app, SQL.crear, [cuenta.correo, ep.nombreEstudio(), null, malo, tokenHashNuevo()]);
    const b = await llamar(app, SQL.crear, [sin, ep.nombreEstudio(), null, malo, tokenHashNuevo()]);
    expect(a.ok ? "ok" : a.code).toBe("23514");
    expect(b.ok ? "ok" : b.code).toBe("23514");
    expect(await adm("select 1 from auth.registro_pendiente where correo = any($1)", [[sin]])).toHaveLength(0);
    expect(exitosa(await vigente(previo))).toHaveLength(1);
  });
});

// =================================================================================================
describe("b7 · precio NaN en plan_crear, plan_editar y en la tabla plan", () => {
  let adminMemo: Promise<{ usuario: { id: string }; sesion: Buffer }> | undefined;
  const comoAdmin = () => (adminMemo ??= ep.administrador());
  const precios = ["precio_mensual", "precio_anual", "precio_ruc_extra"] as const;
  // Infinity ya lo rechaza PG con numeric(14,2) (22003): solo NaN pasa el `>= 0` y `<> round(..., 2)`.
  const MALOS = ["NaN"];

  const args = (codigo: string, o: Partial<Record<(typeof precios)[number], string | null>>) => [
    codigo,
    `Plan NaN ${codigo}`,
    o.precio_mensual ?? "10.00",
    o.precio_anual === undefined ? null : o.precio_anual,
    10,
    5,
    o.precio_ruc_extra ?? "1.00",
    2,
    1440,
    "{}",
    true,
  ];

  it.each(MALOS.flatMap((v) => precios.map((c) => [c, v] as const)))(
    "plan_editar con %s = %s: se rechaza y el plan no cambia",
    async (columna, valor) => {
      const p = await ep.plan();
      const antes = (await adm("select * from plan where id = $1", [p.id]))[0];
      const sesion = (await comoAdmin()).sesion;
      const a = args(p.codigo, { [columna]: valor });
      const r = await llamar(app, SQL.planEditar, [sesion, p.id, ...a]);
      expect(rechazada(r), JSON.stringify(r)).toBe(true);
      expect((await adm("select * from plan where id = $1", [p.id]))[0]).toEqual(antes);
    },
  );

  it.each(MALOS.flatMap((v) => precios.map((c) => [c, v] as const)))(
    "plan_crear con %s = %s: se rechaza y no se guarda el plan",
    async (columna, valor) => {
      const codigo = ep.codigoNuevo();
      const sesion = (await comoAdmin()).sesion;
      const r = await llamar(app, SQL.planCrear, [sesion, ...args(codigo, { [columna]: valor })]);
      expect(rechazada(r), JSON.stringify(r)).toBe(true);
      expect(await adm("select 1 from plan where codigo = $1", [codigo])).toHaveLength(0);
    },
  );

  it.each(MALOS.flatMap((v) => precios.map((c) => [c, v] as const)))(
    "la tabla plan rechaza %s = %s con 23514 (CHECK propio, no solo las funciones)",
    async (columna, valor) => {
      const codigo = ep.codigoNuevo();
      const valores: Record<string, string | null> = {
        precio_mensual: "10.00",
        precio_anual: null,
        precio_ruc_extra: "1.00",
        [columna]: valor,
      };
      const r = await intentarRaw(
        admin,
        null,
        `insert into plan (codigo, nombre, precio_mensual, precio_anual, max_rucs, max_usuarios, precio_ruc_extra, max_rucs_extra, frecuencia_buzon_min)
         values ($1, 'Plan NaN', $2::numeric, $3::numeric, 10, 5, $4::numeric, 2, 1440)`,
        [codigo, valores.precio_mensual, valores.precio_anual, valores.precio_ruc_extra],
      );
      expect(r.ok ? "ok" : r.code).toBe("23514");
    },
  );
});

// =================================================================================================
describe("D15 · auth.limite_consumir('registro_confirmar_ip') y el CHECK de tipos", () => {
  const consumir = async (tipo: string, sujeto: string): Promise<unknown> => {
    const r = await llamar(app, SQL.limite, [tipo, sujeto]);
    if (!r.ok) throw new Error(`limite_consumir fallo (SQLSTATE ${r.code})`);
    return r.rows[0]?.v;
  };

  it("admite 10 consumos por hora y rechaza el 11.º (y los siguientes)", async () => {
    const s = ep.ea.esc.sujeto("registro_confirmar_ip");
    for (let i = 1; i <= 10; i++) expect(await consumir("registro_confirmar_ip", s), `consumo ${i}`).toBe(true);
    expect(await consumir("registro_confirmar_ip", s)).toBe(false);
    expect(await consumir("registro_confirmar_ip", s)).toBe(false);
  });

  it("su contador es independiente del de registro_ip (5 por hora) para el mismo sujeto", async () => {
    const s = ep.ea.esc.sujeto("registro_confirmar_ip");
    for (let i = 0; i < 5; i++) expect(await consumir("registro_ip", s)).toBe(true);
    expect(await consumir("registro_ip", s)).toBe(false);
    expect(await consumir("registro_confirmar_ip", s)).toBe(true);
  });

  it("al vencer la ventana de 1 hora el contador vuelve a admitir consumos", async () => {
    const s = ep.ea.esc.sujeto("registro_confirmar_ip");
    for (let i = 0; i < 10; i++) await consumir("registro_confirmar_ip", s);
    expect(await consumir("registro_confirmar_ip", s)).toBe(false);
    await adm(
      "update auth.limite_tasa set ventana_inicio = now() - interval '61 minutes' where tipo = 'registro_confirmar_ip' and sujeto = $1",
      [s],
    );
    expect(await consumir("registro_confirmar_ip", s)).toBe(true);
  });

  it("acepta la constante `ip_invalida` como sujeto y un tipo desconocido sigue sin conceder", async () => {
    await adm("delete from auth.limite_tasa where tipo = 'registro_confirmar_ip' and sujeto = 'ip_invalida'");
    const r = await llamar(app, SQL.limite, ["registro_confirmar_ip", "ip_invalida"]);
    expect(r.ok && r.rows[0].v, JSON.stringify(r)).toBe(true);
    await adm("delete from auth.limite_tasa where tipo = 'registro_confirmar_ip' and sujeto = 'ip_invalida'");
    const x = await llamar(app, SQL.limite, ["registro_confirmar_otro", ep.ea.esc.sujeto("otro")]);
    expect(!x.ok || x.rows[0].v === false).toBe(true);
  });
});

// =================================================================================================
describe("Ajustes de soporte (T13a): FUNCIONES_AUTH sigue en 28 y 0025 no agrega sobrecargas", () => {
  it("la lista de pruebas tiene 28 funciones y la BD tiene exactamente esas, una por nombre", async () => {
    expect(FUNCIONES_AUTH).toHaveLength(28);
    const r = await adm(
      `select p.proname, count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'auth' group by p.proname order by 1`,
    );
    expect(r.map((x) => x.proname)).toEqual([...FUNCIONES_AUTH].sort());
    expect(r.filter((x) => x.n !== 1)).toEqual([]);
  });
});
