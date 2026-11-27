// Spec 030 · T12 · ronda adversarial 1b (caja blanca: SQL, RLS, bloqueos). Solo afirma el comportamiento SEGURO esperado: una prueba roja es
// un hallazgo. Lee 0082/0083/0084, `packages/db/src/acceso/{roles,miembros,invitaciones}.ts` y `apps/backend/src/modules/acceso/`.
// Conexiones reales: contapp_backend / contapp_worker por el login contapp_app (SET LOCAL ROLE); el superusuario solo siembra, observa
// (pg_stat_activity) y limpia. Cada prueba crea sus estudios (EscenarioRoles, borrados al final).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirAdmin, abrirApp, hashFalso, llamar } from "./auth-soporte";
import { COD, EscenarioRoles, cierreU3, codigo, ejecutar, guardar, probar, probarGuardar, sha256, type Res } from "./roles-soporte";
import type { ContappDb } from "./soporte";

vi.setConfig({ testTimeout: 60_000 });

let admin: Pool;
let app: Pool;
let er: EscenarioRoles;
let db: ContappDb;
beforeAll(() => {
  admin = abrirAdmin(6);
  app = abrirApp(10);
  er = new EscenarioRoles(admin);
  db = er.backend(8);
});
afterAll(async () => {
  await er?.limpiar();
  await er?.cerrar();
  await app?.end();
  await admin?.end();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- filas de pg sin tipo
const adm = async (sql: string, v: unknown[] = []): Promise<any[]> => (await admin.query(sql, v)).rows;
const ctx = (tenantId: string, u?: { id: string }) => ({ tenantId, ...(u ? { userId: u.id } : {}) });
let n = 0;
const nombre = () => `Rol R1b ${er.esc.marca}-${++n}`;
const nombreDe = async (rolId: string): Promise<string> => (await adm("select nombre from rol where id = $1", [rolId]))[0].nombre as string;
const rechazo = (r: Res): string => (r.ok ? "ok" : "rechazado");
const atrapar = (p: Promise<{ rows: unknown[] }>): Promise<Res> =>
  p.then(
    (r) => ({ ok: true as const, rows: r.rows as never[] }),
    (e: { code?: string; message?: string }) => ({ ok: false as const, code: String(e.code ?? ""), message: String(e.message ?? "") }),
  );

const NADA: Res = { ok: false, code: "sin-correr", message: "" };
const ROLES_BD = ["contapp_app", "contapp_auth", "contapp_backend", "contapp_enumerador", "contapp_platform", "contapp_registrador", "contapp_worker"];

/** Transaccion abierta como un rol real de la app (login contapp_app + SET LOCAL ROLE), con el estudio y el actor fijados. */
interface Sesion {
  c: PoolClient;
  q: (sql: string, v?: unknown[]) => Promise<Res>;
  fin: (confirmar: boolean) => Promise<void>;
}
async function sesion(rol: "contapp_backend" | "contapp_worker", tenantId: string | null, userId?: string): Promise<Sesion> {
  const c = await app.connect();
  await c.query("BEGIN");
  await c.query(`SET LOCAL ROLE ${rol}`);
  await c.query("SET LOCAL lock_timeout = '20s'");
  if (tenantId) await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
  if (userId) await c.query("select set_config('app.user_id', $1, true)", [userId]);
  let cerrada = false;
  return {
    c,
    q: (sql, v = []) => atrapar(c.query(sql, v)),
    fin: async (confirmar) => {
      if (cerrada) return;
      cerrada = true;
      await c.query(confirmar ? "COMMIT" : "ROLLBACK").catch(() => c.query("ROLLBACK").catch(() => undefined));
      c.release();
    },
  };
}
/** Una sentencia como `rol` en su propia transaccion, siempre con ROLLBACK. */
async function comoRol(rol: "contapp_backend" | "contapp_worker", tenantId: string, userId: string | undefined, sql: string, v: unknown[] = []) {
  const s = await sesion(rol, tenantId, userId);
  try {
    return await s.q(sql, v);
  } finally {
    await s.fin(false);
  }
}
/** Espera a que alguna sentencia cuyo texto calce con `patron` este esperando un bloqueo (lo observa el superusuario). */
async function esperarEspera(patron: string, ms = 15_000): Promise<void> {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const [{ n: k }] = await adm(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike $1",
      [patron],
    );
    if (k > 0) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`ninguna sentencia ${patron} llego a esperar un bloqueo`);
}

/** Estudio con Dueño y la conexion del backend. */
async function base() {
  const x = await er.estudio();
  const dueno = await er.miembro(x.id, "dueno");
  return { x, dueno, cD: ctx(x.id, dueno) };
}

describe("T12 · privilegios, RLS FORCE y EXECUTE de lo nuevo de 030", () => {
  it("rol y rol_permiso: solo contapp_backend tiene SELECT (ni columnas sueltas, ni TRUNCATE/TRIGGER); RLS FORCE con una sola politica; sin estudio no se ve nada", async () => {
    const privs = await adm(
      `select r || ':' || t || ':' || p as k
         from unnest($1::text[]) r, unnest(array['public.rol', 'public.rol_permiso']) t,
              unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
        where has_table_privilege(r, t, p)
           or (p in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege(r, t, p))
        order by (r || ':' || t || ':' || p) collate "C"`, // orden bytewise: con la collation del servidor (en_US) «_» y «:» se ignoran y el orden cambia entre CI y local
      [ROLES_BD],
    );
    expect(privs.map((x) => x.k)).toEqual(["contapp_backend:public.rol:SELECT", "contapp_backend:public.rol_permiso:SELECT"]);
    const rls = await adm(
      `select c.relname, c.relrowsecurity and c.relforcerowsecurity as forzada,
              (select array_agg(p.polname || '/' || p.polroles::regrole[]::text order by p.polname) from pg_policy p where p.polrelid = c.oid) as pols
         from pg_class c where c.oid in ('public.rol'::regclass, 'public.rol_permiso'::regclass) order by 1`,
    );
    expect(rls).toEqual([
      { relname: "rol", forzada: true, pols: ["tenant_isolation/{-}"] },
      { relname: "rol_permiso", forzada: true, pols: ["tenant_isolation/{-}"] },
    ]);
    // Un usuario Dueño en A y en B: desde A no ve el rol de B; sin estudio (withUsuario) no ve ninguno; no escribe nunca.
    const a = await base();
    const b = await er.estudio();
    await er.membresia(b.id, a.dueno.id, "dueno");
    const ra = await er.rol(a.x.id, { permisos: ["clientes.ver"] });
    const rb = await er.rol(b.id, { permisos: ["clientes.ver"] });
    const vistos: Record<string, unknown> = {};
    const ver = await probar(db, a.cD, "select (select count(*)::int from rol where id = any($1::uuid[])) as r, (select count(*)::int from rol_permiso where rol_id = any($1::uuid[])) as p", [[ra.id, rb.id]]);
    vistos.desdeA = ver.ok ? ver.rows[0] : codigo(ver);
    vistos.sinEstudio = await db.withUsuario({ userId: a.dueno.id }, async (tx) => (await tx.query("select count(*)::int as n from rol where id = any($1::uuid[])", [[ra.id, rb.id]])).rows[0].n);
    vistos.insertar = codigo(await probar(db, a.cD, "insert into rol (nombre, alcance) values ($1, 'global')", [nombre()]));
    vistos.editar = codigo(await probar(db, a.cD, "update rol set alcance = 'global' where id = $1", [ra.id]));
    vistos.permiso = codigo(await probar(db, a.cD, "insert into rol_permiso (rol_id, permiso) values ($1, 'credenciales.editar')", [ra.id]));
    vistos.borrar = codigo(await probar(db, a.cD, "delete from rol_permiso where rol_id = $1", [ra.id]));
    expect(vistos).toEqual({ desdeA: { r: 1, p: 1 }, sinEstudio: 0, insertar: "42501", editar: "42501", permiso: "42501", borrar: "42501" });
  });

  it("EXECUTE cerrado: acceso.*, el disparador y auth.totp_activo solo para quien el plan dice; PUBLIC nunca; USAGE de `acceso` solo backend, auth y worker", async () => {
    const esperado: Record<string, string[]> = {
      "acceso.permisos_membresia": ["contapp_auth", "contapp_worker"], // T17a: el worker revalida con el resolvedor (rojo hasta 0087)
      "acceso.rol_asignable": ["contapp_backend"],
      "acceso.rol_eliminar": ["contapp_backend"],
      "acceso.rol_guardar": ["contapp_backend"],
      "acceso.rol_impacto": ["contapp_backend"],
      "auth.totp_activo": ["contapp_auth"],
      "auth.invitacion_vigente": ["contapp_auth", "contapp_backend"],
      "auth.invitacion_aceptar_nueva": ["contapp_auth", "contapp_backend"],
      "auth.invitacion_aceptar_existente": ["contapp_auth", "contapp_backend"],
      "auth.totp_desactivar": ["contapp_auth", "contapp_backend"],
      "public.rol_propio_asignar": [],
    };
    const filas = await adm(
      `select n.nspname || '.' || p.proname as f,
              array(select r from unnest($1::text[]) r where has_function_privilege(r, p.oid, 'EXECUTE') order by r) as quien,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as publico,
              p.prosecdef as definer, coalesce(p.proconfig::text, '') as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'acceso' or (n.nspname || '.' || p.proname) = any($2::text[])
        order by 1`,
      [ROLES_BD, Object.keys(esperado)],
    );
    const quien = Object.fromEntries(filas.map((x) => [x.f, x.quien]));
    const debe = Object.fromEntries(filas.map((x) => [x.f, esperado[x.f] ?? []]));
    expect(quien).toEqual(debe);
    expect(filas.filter((x) => x.publico).map((x) => x.f)).toEqual([]);
    for (const x of filas) expect(x.cfg, x.f).toContain("search_path=pg_catalog, pg_temp");
    for (const x of filas.filter((y) => y.f !== "public.rol_propio_asignar")) expect(x.definer, x.f).toBe(true);
    const esq = await adm(
      `select array(select r from unnest($1::text[]) r where has_schema_privilege(r, 'acceso', 'USAGE') order by r) as usa,
              array(select r from unnest($1::text[]) r where has_schema_privilege(r, 'acceso', 'CREATE') order by r) as crea`,
      [ROLES_BD],
    );
    expect(esq[0]).toEqual({ usa: ["contapp_auth", "contapp_backend", "contapp_worker"], crea: [] }); // T17a: USAGE del worker (rojo hasta 0087)
  });

  it("rol_id entre estudios: desde A no se asigna, invita, edita, elimina ni mide un rol de B, y rol_asignable con el estudio ajeno dice no", async () => {
    const a = await base();
    const mA = await er.miembro(a.x.id, "contador");
    const b = await er.estudio();
    const rb = await er.rol(b.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const vistos = {
      asignar: rechazo(await probar(db, a.cD, "update membresia set rol = 'propio', rol_id = $1 where usuario_id = $2", [rb.id, mA.id])),
      alta: rechazo(await probar(db, a.cD, "insert into membresia (usuario_id, rol, rol_id) values ($1, 'propio', $2)", [(await er.cuenta()).id, rb.id])),
      invitar: rechazo(
        await probar(db, a.cD, "insert into invitacion (correo, rol, rol_id, invitado_por, token_hash) values ($1, 'propio', $2, $3, $4)", [
          er.esc.correoNuevo(),
          rb.id,
          a.dueno.id,
          randomBytes(32),
        ]),
      ),
      guardar: codigo(await probarGuardar(db, a.cD, { id: rb.id, nombre: nombre(), alcance: "asignado", permisos: [] })),
      eliminar: codigo(await probar(db, a.cD, "select acceso.rol_eliminar($1::uuid)", [rb.id])),
      impacto: codigo(await probar(db, a.cD, "select * from acceso.rol_impacto($1::uuid, 'asignado', '{}'::text[])", [rb.id])),
      asignable: (await probar(db, a.cD, "select acceso.rol_asignable($1::uuid, $2::uuid) as x", [b.id, rb.id])) as Res,
    };
    expect({ ...vistos, asignable: vistos.asignable.ok ? vistos.asignable.rows[0].x : codigo(vistos.asignable) }).toEqual({
      asignar: "rechazado",
      alta: "rechazado",
      invitar: "rechazado",
      guardar: COD.noExiste,
      eliminar: COD.noExiste,
      impacto: COD.noExiste,
      asignable: false,
    });
    expect(await adm("select count(*)::int as n from rol_permiso where rol_id = $1", [rb.id])).toEqual([{ n: 1 }]);
  });
});

describe("T12 · el disparador de asignacion (SECURITY INVOKER) no se elude", () => {
  it("el backend no apaga ni reemplaza el disparador ni se hace pasar por contapp_auth/migrador; el worker no asigna un rol propio", async () => {
    const a = await base();
    const r = await er.rol(a.x.id, { alcance: "global", permisos: cierreU3(["credenciales.editar", "usuarios.gestionar"]) });
    const m = await er.miembro(a.x.id, "lectura");
    const be = (sql: string, v: unknown[] = []) => comoRol("contapp_backend", a.x.id, a.dueno.id, sql, v).then(codigo);
    const vistos = {
      replica: await be("SET LOCAL session_replication_role = replica"),
      apagarMembresia: await be("ALTER TABLE public.membresia DISABLE TRIGGER membresia_rol_propio"),
      apagarInvitacion: await be("ALTER TABLE public.invitacion DISABLE TRIGGER invitacion_rol_propio"),
      reemplazar: await be("CREATE OR REPLACE FUNCTION public.rol_propio_asignar() RETURNS trigger LANGUAGE plpgsql AS $f$BEGIN RETURN NEW; END$f$"),
      comoAuth: await be("SET LOCAL ROLE contapp_auth"),
      comoMigrador: await be("SET LOCAL ROLE contapp_migrator"),
      workerAsigna: codigo(await comoRol("contapp_worker", a.x.id, a.dueno.id, "update membresia set rol = 'propio', rol_id = $1 where usuario_id = $2", [r.id, m.id])),
      workerAlta: codigo(
        await comoRol("contapp_worker", a.x.id, a.dueno.id, "insert into membresia (usuario_id, rol, rol_id) values ($1, 'propio', $2)", [(await er.cuenta()).id, r.id]),
      ),
    };
    expect(vistos).toEqual({
      replica: "42501",
      apagarMembresia: "42501",
      apagarInvitacion: "42501",
      reemplazar: "42501",
      comoAuth: "42501",
      comoMigrador: "42501",
      workerAsigna: "42501",
      workerAlta: "42501",
    });
    expect(await adm("select rol, rol_id from membresia where usuario_id = $1", [m.id])).toEqual([{ rol: "lectura", rol_id: null }]);
  });

  it("D2: traspasar una membresia (o una invitacion) de un rol propio que el actor NO contiene a otra persona tambien pasa por la regla", async () => {
    // El disparador solo mira `rol_id`/`tenant_id`; pero cambiar `usuario_id` de la membresia (o el `correo` de la invitacion) entrega
    // ese rol a OTRA persona: es una asignacion. contapp_backend tiene UPDATE sobre ambas columnas.
    const a = await base();
    const actor = await er.actor(a.x.id, ["usuarios.gestionar"]);
    const poderoso = await er.rol(a.x.id, { alcance: "global", permisos: cierreU3(["credenciales.editar", "usuarios.gestionar", "roles.gestionar"]) });
    const titular = await er.miembroPropio(a.x.id, poderoso.id);
    const otro = await er.miembro(a.x.id, "lectura");
    const extrano = await er.cuenta();
    const inv = await er.invitacionPropia(a.x.id, poderoso.id, a.dueno.id);
    const cX = ctx(a.x.id, actor);
    const vistos = {
      control: codigo(await probar(db, cX, "update membresia set rol = 'propio', rol_id = $1 where usuario_id = $2", [poderoso.id, otro.id])),
      traspaso: codigo(await probar(db, cX, "update membresia set usuario_id = $1 where usuario_id = $2", [extrano.id, titular.id])),
      redirigir: codigo(await probar(db, cX, "update invitacion set correo = $1 where id = $2", [er.esc.correoNuevo(), inv.id])),
    };
    expect(vistos).toEqual({ control: COD.escalada, traspaso: COD.escalada, redirigir: COD.escalada });
  });
});

describe("T12 · escalada en rol_guardar / rol_eliminar (la regla vive en la BD)", () => {
  it("sin roles.gestionar, alcance asignado creando global, permiso ajeno, rol propio, 'antes' que excede, actor desactivado, de otro estudio o sin actor", async () => {
    const a = await base();
    const sinGestion = await er.actor(a.x.id, ["usuarios.gestionar"]);
    const gestor = await er.actor(a.x.id, ["roles.gestionar", "clientes.ver"], "asignado");
    const ajeno = await er.rol(a.x.id, { alcance: "asignado", permisos: cierreU3(["credenciales.editar"]) });
    const desact = await er.actor(a.x.id, ["roles.gestionar", "clientes.ver"], "global");
    await adm("update membresia set desactivada_en = now() where usuario_id = $1", [desact.id]);
    const b = await er.estudio();
    const duenoB = await er.miembro(b.id, "dueno");
    const g = (c: { tenantId: string; userId?: string }, r: { id?: string; alcance: "global" | "asignado"; permisos: string[] }) =>
      probarGuardar(db, c, { nombre: nombre(), ...r }).then(codigo);
    const nombreGestor = await nombreDe(gestor.rolId);
    const vistos = {
      sinRolesGestionar: await g(ctx(a.x.id, sinGestion), { alcance: "asignado", permisos: ["clientes.ver"] }),
      asignadoCreaGlobal: await g(ctx(a.x.id, gestor), { alcance: "global", permisos: ["clientes.ver"] }),
      permisoAjeno: await g(ctx(a.x.id, gestor), { alcance: "asignado", permisos: cierreU3(["credenciales.editar"]) }),
      editarPropio: codigo(await probarGuardar(db, ctx(a.x.id, gestor), { id: gestor.rolId, nombre: nombreGestor, alcance: "asignado", permisos: cierreU3(["roles.gestionar"]) })),
      eliminarPropio: codigo(await probar(db, ctx(a.x.id, gestor), "select acceso.rol_eliminar($1::uuid)", [gestor.rolId])),
      antesExcede: await g(ctx(a.x.id, gestor), { id: ajeno.id, alcance: "asignado", permisos: ["clientes.ver"] }),
      eliminarExcede: codigo(await probar(db, ctx(a.x.id, gestor), "select acceso.rol_eliminar($1::uuid)", [ajeno.id])),
      desactivado: await g(ctx(a.x.id, desact), { alcance: "asignado", permisos: ["clientes.ver"] }),
      deOtroEstudio: await g(ctx(a.x.id, duenoB), { alcance: "asignado", permisos: ["clientes.ver"] }),
      sinActor: await g(ctx(a.x.id), { alcance: "asignado", permisos: ["clientes.ver"] }),
      planGestionar: await g(a.cD, { alcance: "global", permisos: ["plan.gestionar"] }),
    };
    expect(vistos).toEqual({
      sinRolesGestionar: COD.escalada,
      asignadoCreaGlobal: COD.escalada,
      permisoAjeno: COD.escalada,
      editarPropio: COD.rolPropio,
      eliminarPropio: COD.rolPropio,
      antesExcede: COD.escalada,
      eliminarExcede: COD.escalada,
      desactivado: COD.escalada,
      deOtroEstudio: COD.escalada,
      sinActor: COD.escalada,
      planGestionar: COD.check,
    });
    expect(await er.roles(a.x.id)).toBe(4);
  });

  it("carrera: el actor pasa a tener el rol MIENTRAS lo edita: rol_guardar relee al actor tras bloquearlo y responde RL001 (nunca edita su propio rol)", async () => {
    const a = await base();
    const actor = await er.actor(a.x.id, ["roles.gestionar", "usuarios.gestionar", "sire.clasificar"]);
    const rb = await er.rol(a.x.id, { alcance: "asignado", permisos: cierreU3(["roles.gestionar", "sire.clasificar"]) });
    const nb = await nombreDe(rb.id);
    const t1 = await sesion("contapp_backend", a.x.id, a.dueno.id);
    let r2: Res = NADA;
    try {
      await t1.q("select usuario_id from membresia where usuario_id = any($1::uuid[]) order by usuario_id for update", [[a.dueno.id, actor.id]]);
      const cambio = await t1.q("update membresia set rol = 'propio', rol_id = $1 where usuario_id = $2", [rb.id, actor.id]);
      expect(codigo(cambio)).toBe("ok");
      const p2 = guardar(db, ctx(a.x.id, actor), { id: rb.id, nombre: nb, alcance: "asignado", permisos: cierreU3(["roles.gestionar"]) });
      await esperarEspera("%rol_guardar%");
      await t1.fin(true);
      r2 = await p2;
    } finally {
      await t1.fin(false);
    }
    expect(codigo(r2)).toBe(COD.rolPropio);
    expect((await adm("select array_agg(permiso order by permiso) as p from rol_permiso where rol_id = $1", [rb.id]))[0].p).toContain("sire.clasificar");
  });
});

describe("T12 · invitaciones pendientes cuando el invitador pierde permisos por editar SU rol (005 D8, ampliada por U2)", () => {
  it("el rol del invitador se edita y ya no contiene el rol invitado: la invitacion deja de ser vigente y no se acepta", async () => {
    const a = await base();
    const invitador = await er.actor(a.x.id, ["usuarios.gestionar", "credenciales.editar"]);
    const ry = await er.rol(a.x.id, { alcance: "asignado", permisos: cierreU3(["credenciales.editar"]) });
    const correo = er.esc.correoNuevo();
    er.recordarCorreo(correo);
    const token = randomBytes(32);
    // La emite el invitador por el camino del backend (el disparador la valida: el invitador contiene el rol).
    const emitida = await ejecutar(
      db,
      ctx(a.x.id, invitador),
      "insert into invitacion (correo, rol, rol_id, invitado_por, token_hash, vence_en) values ($1, 'propio', $2, $3, $4, now() + interval '72 hours') returning id",
      [correo, ry.id, invitador.id, sha256(token)],
    );
    expect(codigo(emitida)).toBe("ok");
    // Un Dueño le quita credenciales.editar al rol del invitador (sigue con usuarios.gestionar).
    const editado = await guardar(db, a.cD, { id: invitador.rolId, nombre: await nombreDe(invitador.rolId), alcance: "asignado", permisos: cierreU3(["usuarios.gestionar"]) });
    expect(codigo(editado)).toBe("ok");
    const vigente = await llamar(app, "select * from auth.invitacion_vigente($1)", [sha256(token)]);
    const aceptar = await llamar(app, "select auth.invitacion_aceptar_nueva($1, $2, $3) as r", [sha256(token), "Invitada R1b", hashFalso()]);
    expect({ vigente: vigente.ok ? vigente.rows.length : codigo(vigente), aceptar: aceptar.ok ? aceptar.rows[0].r : codigo(aceptar) }).toEqual({
      vigente: 0,
      aceptar: "invalida",
    });
  });
});

describe("T12 · orden de bloqueo D4 y carreras de 0084", () => {
  it("invitar de nuevo a un correo con invitacion vencida del rol MIENTRAS se elimina el rol: sin interbloqueo (40P01)", async () => {
    // crearInvitacion (packages/db/src/acceso/invitaciones.ts): bloquearMiembros(actor) -> revoca la vencida del correo (fila de invitacion)
    // -> INSERT (el disparador pide el rol FOR SHARE y la FK FOR KEY SHARE). rol_eliminar: rol FOR UPDATE -> invitaciones del rol FOR UPDATE.
    const a = await base();
    const otroGestor = await er.miembro(a.x.id, "admin");
    const r = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const vieja = await er.invitacionPropia(a.x.id, r.id, otroGestor.id, { vencida: true });
    const t1 = await sesion("contapp_backend", a.x.id, otroGestor.id);
    let r1: Res = NADA;
    let r2: Res = NADA;
    try {
      await t1.q("select usuario_id from membresia where usuario_id = any($1::uuid[]) order by usuario_id for update", [[otroGestor.id]]);
      const rev = await t1.q(
        "update invitacion set revocada_en = now() where correo = $1 and aceptada_en is null and revocada_en is null and vence_en <= now()",
        [vieja.correo],
      );
      expect(rev.ok && rev.rows.length === 0).toBe(true);
      const p2 = ejecutar(db, a.cD, "select acceso.rol_eliminar($1::uuid)", [r.id]);
      await esperarEspera("%rol_eliminar%");
      r1 = await t1.q(
        "insert into invitacion (correo, rol, rol_id, invitado_por, token_hash, vence_en) values ($1, 'propio', $2, $3, $4, now() + interval '72 hours')",
        [vieja.correo, r.id, otroGestor.id, randomBytes(32)],
      );
      await t1.fin(r1.ok);
      r2 = await p2;
    } finally {
      await t1.fin(false);
    }
    expect([codigo(r1), codigo(r2)].filter((c) => c === COD.interbloqueo)).toEqual([]);
  });

  it("0084 con reactivacion concurrente de un miembro DESACTIVADO del rol, en ambos ordenes: nunca queda activo con el rol borrado ni hay 40P01", async () => {
    const a = await base();
    // Orden 1: la reactivacion confirma primero -> rol_eliminar ve un miembro activo -> 23503 y nada cambia.
    const r1 = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const m1 = await er.miembroPropio(a.x.id, r1.id, { desactivada: true });
    const t1 = await sesion("contapp_backend", a.x.id, a.dueno.id);
    let e1: Res = NADA;
    try {
      await t1.q("select usuario_id from membresia where usuario_id = any($1::uuid[]) order by usuario_id for update", [[a.dueno.id, m1.id]]);
      await t1.q("update membresia set desactivada_en = null, updated_at = now() where usuario_id = $1", [m1.id]);
      const p = ejecutar(db, a.cD, "select acceso.rol_eliminar($1::uuid)", [r1.id]);
      await esperarEspera("%rol_eliminar%");
      await t1.fin(true);
      e1 = await p;
    } finally {
      await t1.fin(false);
    }
    // Orden 2: rol_eliminar confirma primero -> la reactivacion espera y el miembro vuelve como 'lectura' sin rol_id.
    const r2 = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const m2 = await er.miembroPropio(a.x.id, r2.id, { desactivada: true });
    const t2 = await sesion("contapp_backend", a.x.id, a.dueno.id);
    let e2: Res = NADA;
    let reac: Res = NADA;
    try {
      e2 = await t2.q("select acceso.rol_eliminar($1::uuid)", [r2.id]);
      const p = ejecutar(db, a.cD, "update membresia set desactivada_en = null, updated_at = now() where usuario_id = $1 returning rol, rol_id", [m2.id]);
      await esperarEspera("%desactivada_en = null%");
      await t2.fin(true);
      reac = await p;
    } finally {
      await t2.fin(false);
    }
    const estado = async (u: string) => (await adm("select rol, rol_id, desactivada_en is null as activo from membresia where usuario_id = $1", [u]))[0];
    expect({
      e1: codigo(e1),
      m1: await estado(m1.id),
      e2: codigo(e2),
      reac: reac.ok ? reac.rows : codigo(reac),
      m2: await estado(m2.id),
      r2: (await adm("select count(*)::int as n from rol where id = $1", [r2.id]))[0].n,
    }).toEqual({
      e1: COD.enUso,
      m1: { rol: "propio", rol_id: r1.id, activo: true },
      e2: "ok",
      reac: [{ rol: "lectura", rol_id: null }],
      m2: { rol: "lectura", rol_id: null, activo: true },
      r2: 0,
    });
  });

  it("U6 en carrera: un miembro que entra al rol mientras este pierde sire.clasificar tambien deja de ser responsable", async () => {
    const a = await base();
    const gestor = await er.miembro(a.x.id, "admin");
    const r = await er.rol(a.x.id, { alcance: "asignado", permisos: cierreU3(["sire.clasificar"]) });
    const m = await er.miembro(a.x.id, "contador");
    const cli = await er.cliente(a.x.id);
    await er.asignar(a.x.id, cli, m.id, "responsable");
    const t1 = await sesion("contapp_backend", a.x.id, a.dueno.id);
    let g: Res = NADA;
    try {
      await t1.q("select usuario_id from membresia where usuario_id = any($1::uuid[]) order by usuario_id for update", [[a.dueno.id, m.id]]);
      expect(codigo(await t1.q("update membresia set rol = 'propio', rol_id = $1 where usuario_id = $2", [r.id, m.id]))).toBe("ok");
      const p = guardar(db, ctx(a.x.id, gestor), { id: r.id, nombre: await nombreDe(r.id), alcance: "asignado", permisos: ["clientes.ver"] });
      await esperarEspera("%rol_guardar%");
      await t1.fin(true);
      g = await p;
    } finally {
      await t1.fin(false);
    }
    expect({ g: codigo(g), tipo: (await adm("select tipo from asignacion where cliente_id = $1 and usuario_id = $2", [cli, m.id]))[0]?.tipo }).toEqual({
      g: "ok",
      tipo: "colaborador",
    });
  });
});

describe("T12 · CHECKs, nombres y auditoria", () => {
  it("los CHECK y las FK compuestas valen aun escribiendo con el superusuario (fuera de las funciones)", async () => {
    const a = await base();
    const b = await er.estudio();
    const ra = await er.rol(a.x.id, { permisos: ["clientes.ver"] });
    const u = await er.cuenta();
    const c = await admin.connect();
    const vistos: Record<string, string> = {};
    try {
      await c.query("BEGIN");
      const casos: Record<string, [string, unknown[]]> = {
        planGestionar: ["insert into rol_permiso (tenant_id, rol_id, permiso) values ($1, $2, 'plan.gestionar')", [a.x.id, ra.id]],
        fueraCatalogo: ["insert into rol_permiso (tenant_id, rol_id, permiso) values ($1, $2, 'todo')", [a.x.id, ra.id]],
        permisoOtroEstudio: ["insert into rol_permiso (tenant_id, rol_id, permiso) values ($1, $2, 'buzon.ver')", [b.id, ra.id]],
        propioSinRolId: ["insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'propio')", [a.x.id, u.id]],
        sistemaConRolId: ["insert into membresia (tenant_id, usuario_id, rol, rol_id) values ($1, $2, 'contador', $3)", [a.x.id, u.id, ra.id]],
        membresiaOtroEstudio: ["insert into membresia (tenant_id, usuario_id, rol, rol_id) values ($1, $2, 'propio', $3)", [b.id, u.id, ra.id]],
        invitacionSinRolId: [
          "insert into invitacion (tenant_id, correo, rol, invitado_por, token_hash) values ($1, $2, 'propio', $3, $4)",
          [a.x.id, er.esc.correoNuevo(), a.dueno.id, randomBytes(32)],
        ],
        nombreSistema: ["insert into rol (tenant_id, nombre, alcance) values ($1, ' DUEÑO ', 'global')", [a.x.id]],
        nombreVacio: ["insert into rol (tenant_id, nombre, alcance) values ($1, '   ', 'global')", [a.x.id]],
        alcance: ["insert into rol (tenant_id, nombre, alcance) values ($1, $2, 'todo')", [a.x.id, nombre()]],
      };
      for (const [k, [sql, v]] of Object.entries(casos)) {
        await c.query("SAVEPOINT s");
        vistos[k] = await c.query(sql, v).then(
          () => "ok",
          (e: { code?: string }) => String(e.code),
        );
        await c.query("ROLLBACK TO SAVEPOINT s");
      }
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    expect(vistos).toEqual({
      planGestionar: "23514",
      fueraCatalogo: "23514",
      permisoOtroEstudio: "23503",
      propioSinRolId: "23514",
      sistemaConRolId: "23514",
      membresiaOtroEstudio: "23503",
      invitacionSinRolId: "23514",
      nombreSistema: "23514",
      nombreVacio: "23514",
      alcance: "23514",
    });
  });

  it("un rol propio no se llama como uno de sistema ni repite un nombre con espacios o caracteres invisibles (NBSP, ZWSP, ZWJ, WJ)", async () => {
    const a = await base();
    const base_ = `Auditor ${er.esc.marca}`;
    expect(codigo(await guardar(db, a.cD, { nombre: base_, alcance: "asignado", permisos: ["clientes.ver"] }))).toBe("ok");
    const disfraces: Record<string, string> = {
      duenoNbsp: "Dueño ",
      duenoZwsp: "Due​ño",
      adminWj: "⁠Administrador",
      contadorZwj: "Contador‍",
      lecturaNbsp: "Solo lectura",
      repetidoNbsp: `${base_} `,
      repetidoZwsp: `Audi​tor ${er.esc.marca}`,
    };
    const vistos: Record<string, string> = {};
    for (const [k, nom] of Object.entries(disfraces)) vistos[k] = codigo(await probarGuardar(db, a.cD, { nombre: nom, alcance: "asignado", permisos: ["clientes.ver"] }));
    expect(vistos).toEqual({
      duenoNbsp: COD.check,
      duenoZwsp: COD.check,
      adminWj: COD.check,
      contadorZwj: COD.check,
      lecturaNbsp: COD.check,
      repetidoNbsp: COD.duplicado,
      repetidoZwsp: COD.duplicado,
    });
  });

  it("auditoria de invitaciones con rol propio: `invitacion.creada` dice QUE rol propio y cambiar rol_id deja `invitacion.modificada` (como 0083 para membresia), sin correo ni token", async () => {
    const a = await base();
    const r1 = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const r2 = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver", "buzon.ver"] });
    const correo = er.esc.correoNuevo();
    er.recordarCorreo(correo);
    const hash = randomBytes(32);
    const ins = await ejecutar(
      db,
      a.cD,
      "insert into invitacion (correo, rol, rol_id, invitado_por, token_hash, vence_en) values ($1, 'propio', $2, $3, $4, now() + interval '72 hours') returning id",
      [correo, r1.id, a.dueno.id, hash],
    );
    expect(codigo(ins)).toBe("ok");
    const id = (ins as { rows: { id: string }[] }).rows[0].id;
    expect(codigo(await ejecutar(db, a.cD, "update invitacion set rol_id = $1 where id = $2", [r2.id, id]))).toBe("ok");
    const filas = await adm("select accion, datos from auditoria where entidad = 'invitacion' and entidad_id = $1 order by ocurrida_en, id", [id]);
    const texto = JSON.stringify(filas);
    expect(texto).not.toContain(correo);
    expect(texto).not.toContain(hash.toString("hex"));
    const creada = filas.find((f) => f.accion === "invitacion.creada");
    expect({
      creadaRolId: creada?.datos?.rolId ?? null,
      modificadas: filas.filter((f) => f.accion === "invitacion.modificada").length,
    }).toEqual({ creadaRolId: r1.id, modificadas: 1 });
  });

  it("0082, 0083 y 0084 se reaplican sobre una BD ya migrada sin error y dejan rol_eliminar de 0084 (repetibles)", async () => {
    const dir = fileURLToPath(new URL("../../packages/db/migrations/", import.meta.url));
    const c = await admin.connect();
    let error: string | null = null;
    let src = "";
    try {
      await c.query("BEGIN");
      for (const f of ["0082_roles_propios.sql", "0083_roles_propios_auditoria.sql", "0084_roles_eliminar_no_vigentes.sql"]) {
        try {
          await c.query(readFileSync(dir + f, "utf8"));
        } catch (e) {
          error = `${f}: ${(e as { code?: string }).code}`;
          break;
        }
      }
      if (error === null) src = (await c.query("select prosrc from pg_proc where oid = 'acceso.rol_eliminar(uuid)'::regprocedure")).rows[0].prosrc;
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    expect(error).toBeNull();
    expect(src).toContain("invitacionesDepuradas");
  });
});
