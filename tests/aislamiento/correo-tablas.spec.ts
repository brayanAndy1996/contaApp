// Spec 028 (T3, rojo): tablas de correo en BD real (R-11, D-2, CA-1, CA-5, CA-8). Aislamiento por RLS, grants, escritura directa (42501),
// CHECK y unicas de correo_preferencia, correo_envio, correo_envio_aviso, correo_baja_token y la fila unica correo_programacion.
// Falla hoy porque las migraciones 0073-0074 aun no existen. El contrato esta en la cabecera de correo-soporte.ts.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentar, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  conSistema,
  crearDb,
  enTx,
  EscenarioCorreo,
  probar,
  ROLES_SIN_ACCESO,
  TABLAS_CORREO,
  TABLAS_CORREO_ESTUDIO,
  tokenNuevo,
} from "./correo-soporte";

let admin: Pool;
let ec: EscenarioCorreo;
let backend: ContappDb;
let worker: ContappDb;
let sistema: ReturnType<typeof conSistema>;
let X: string;
let Y: string;
let uC: string; // contador de X (con preferencias y envios)
let uD: string; // dueño de X
let uY: string; // contador de Y
let uXY: string; // contador en X y en Y
let notifC: string; // notificacion de uC en X
let notifY: string; // notificacion de uY en Y
let envC: string; // envio pendiente de uC en X
let envY: string; // envio pendiente de uY en Y

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioCorreo(admin);
  await ec.guardarProgramacionCorreo();
  X = await ec.estudioPlan();
  Y = await ec.estudioPlan();
  uC = (await ec.et.miembro(X, "contador")).id;
  uD = (await ec.et.miembro(X, "dueno")).id;
  uY = (await ec.et.miembro(Y, "contador")).id;
  const xy = await ec.et.ea.cuenta();
  uXY = xy.id;
  await ec.et.ea.membresia(X, uXY, "contador");
  await ec.et.ea.membresia(Y, uXY, "contador");
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
  sistema = conSistema("contapp_worker", 2);
  // Estado previo (superusuario, solo para armar el escenario de aislamiento).
  for (const [t, u] of [
    [X, uC],
    [X, uD],
    [X, uXY],
    [Y, uY],
    [Y, uXY],
  ] as const) {
    await ec.preferencia(t, u, "buzon_critico", true);
    if (u !== uD) await ec.preferencia(t, u, "resumen", false);
  }
  notifC = await ec.notificar(X, uC, { tipo: "buzon_critico", params: { categoria: "coactiva", mensajeId: randomUUID() } });
  notifY = await ec.notificar(Y, uY, { tipo: "buzon_critico", params: { categoria: "coactiva", mensajeId: randomUUID() } });
  envC = await envio(X, uC);
  envY = await envio(Y, uY);
  await envio(X, uD);
  await envio(X, uXY);
  await envio(Y, uXY);
  for (const [t, u, n, e] of [
    [X, uC, notifC, envC],
    [Y, uY, notifY, envY],
  ] as const) {
    await admin.query(
      "insert into correo_envio_aviso (tenant_id, notificacion_id, usuario_id, tipo, envio_id) values ($1, $2, $3, 'buzon_critico', $4)",
      [t, n, u, e],
    );
  }
  await admin.query(
    "insert into correo_baja_token (tenant_id, hash, usuario_id, tipo, envio_id, vence_en) values ($1, $2, $3, 'buzon_critico', $4, now() + interval '90 days')",
    [X, tokenNuevo().hash, uC, envC],
  );
});
afterAll(async () => {
  await ec?.limpiar();
  for (const d of [backend, worker, sistema]) await d?.close().catch(() => undefined);
  await admin?.end();
});

/** Envio `pendiente` de origen `aviso` sembrado directo (solo para armar el estado previo). */
async function envio(tenantId: string, usuarioId: string, o: { tipo?: string; estado?: string; tomado?: boolean } = {}): Promise<string> {
  const r = await admin.query(
    `insert into correo_envio (tenant_id, usuario_id, origen, tipo, estado, clave, programado_para, intentos, total_avisos, tomado_en)
     values ($1, $2, 'aviso', $3, $4, $5, now(), case when $6::boolean then 1 else 0 end, 1, case when $6::boolean then now() else null end) returning id`,
    [tenantId, usuarioId, o.tipo ?? "buzon_critico", o.estado ?? "pendiente", `aviso:${usuarioId}:${randomUUID()}`, o.tomado ?? false],
  );
  return r.rows[0].id as string;
}

const rechazo = (r: { ok: boolean; code?: string }, code: string) => {
  expect(r.ok, "la sentencia debia fallar").toBe(false);
  if (!r.ok) expect((r as { code: string }).code).toBe(code);
};
const ctxB = (tenantId: string, userId?: string) => ({ tenantId, ...(userId ? { userId } : {}) });
const filas = (db: ContappDb, ctx: { tenantId: string; userId?: string }, sql: string) =>
  db.withTenant(ctx, async (tx) => (await tx.query(sql)).rows);

describe("catalogo: las cinco tablas existen con dueño, RLS y tenant_id como manda el plan (R-11)", () => {
  it.each(TABLAS_CORREO)("%s existe, es de contapp_migrator y tiene RLS ENABLE", async (t) => {
    const r = await admin.query(
      `select o.rolname as dueno, c.relrowsecurity as rls
         from pg_class c join pg_roles o on o.oid = c.relowner
        where c.oid = to_regclass($1) and c.relkind in ('r', 'p')`,
      [`public.${t}`],
    );
    expect(r.rows, `falta la tabla ${t} (migracion 0073)`).toEqual([{ dueno: "contapp_migrator", rls: true }]);
  });

  it.each(TABLAS_CORREO_ESTUDIO)("%s: RLS FORCE, tenant_id uuid NOT NULL con default app.tenant_id", async (t) => {
    const r = await admin.query(
      `select c.relforcerowsecurity as forzada, a.attnotnull as no_nula, ty.typname as tipo,
              pg_get_expr(d.adbin, d.adrelid) as def
         from pg_class c
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
         join pg_type ty on ty.oid = a.atttypid
         left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
        where c.oid = to_regclass($1)`,
      [`public.${t}`],
    );
    expect(r.rows).toHaveLength(1);
    expect({ forzada: r.rows[0].forzada, no_nula: r.rows[0].no_nula, tipo: r.rows[0].tipo }).toEqual({
      forzada: true,
      no_nula: true,
      tipo: "uuid",
    });
    expect(String(r.rows[0].def)).toContain("app.tenant_id");
  });

  it("correo_programacion es de plataforma: no tiene tenant_id (una sola fila) y no tiene politicas", async () => {
    const c = await admin.query(
      "select 1 from pg_attribute where attrelid = to_regclass('public.correo_programacion') and attname = 'tenant_id' and not attisdropped",
    );
    expect(c.rowCount).toBe(0);
    const p = await admin.query("select 1 from pg_policies where schemaname = 'public' and tablename = 'correo_programacion'");
    expect(p.rowCount).toBe(0);
    expect((await admin.query("select count(*)::int as n from correo_programacion")).rows[0].n).toBe(1);
  });

  it("correo_programacion trae los valores iniciales de U-6 y D-2/U-9: 07:00, lunes a viernes, ventana 10, tope 30, lote 1000", async () => {
    const f = (await ec.programacionCorreo()) as Record<string, unknown>;
    expect(String(f.hora_resumen)).toMatch(/^07:00(:00)?$/);
    expect(f.dias_resumen).toEqual([1, 2, 3, 4, 5]);
    expect(f).toMatchObject({ ventana_min: 10, tope_diario: 30, lote: 1000, ciclo_dueno: null, ciclo_hasta: null });
  });

  it("la auditoria admite correo.preferencia_cambiada sin perder las acciones anteriores", async () => {
    const r = await admin.query("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'auditoria_accion_valida'");
    const def = String(r.rows[0].def);
    expect(def).toContain("correo.preferencia_cambiada");
    for (const previa of ["buzon.atendido", "gnd.categorias_cliente", "prorrata.usada_guardada", "cliente.creado"]) {
      expect(def, previa).toContain(previa);
    }
  });
});

// ---- grants -------------------------------------------------------------------------------------------------------------------
type Matriz = Record<string, Record<string, string[]>>;
const SELECT_DE = (...roles: string[]) => Object.fromEntries(roles.map((r) => [r, ["SELECT"]]));
/** Privilegios de TABLA esperados por rol (R-11, plan: backend solo SELECT de preferencias y envios propios; worker SELECT; tokens y programacion sin grants). */
const ESPERADO: Matriz = {
  correo_preferencia: SELECT_DE("contapp_backend", "contapp_worker"),
  correo_envio: SELECT_DE("contapp_backend", "contapp_worker"),
  correo_envio_aviso: SELECT_DE("contapp_worker"),
  correo_baja_token: {},
  correo_programacion: {},
};
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

describe("grants: backend solo SELECT de lo propio, worker SELECT, tokens y programacion sin grants (R-11)", () => {
  it.each(Object.entries(ESPERADO).flatMap(([t, roles]) => ["contapp_backend", "contapp_worker", ...ROLES_SIN_ACCESO].map((r) => [t, r, roles[r] ?? []] as const)))(
    "%s · %s: privilegios de tabla = %j",
    async (tabla, rol, esperados) => {
      const concedidos: string[] = [];
      for (const p of PRIVS) {
        const r = await admin.query("select has_table_privilege($1, $2, $3) as ok", [rol, `public.${tabla}`, p]);
        if (r.rows[0].ok === true) concedidos.push(p);
      }
      expect(concedidos).toEqual(esperados);
      // Ningun privilegio por columna que no este ya en la tabla (INSERT, UPDATE y REFERENCES por columna abririan una escritura directa).
      for (const p of ["INSERT", "UPDATE", "REFERENCES"]) {
        const r = await admin.query("select has_any_column_privilege($1, $2, $3) as ok", [rol, `public.${tabla}`, p]);
        expect(r.rows[0].ok, `${rol} ${p} por columna`).toBe(false);
      }
    },
  );

  it.each(TABLAS_CORREO)("%s: PUBLIC no tiene ningun privilegio (tabla ni columnas)", async (t) => {
    const r = await admin.query(
      `select 'tabla' as nivel, a.privilege_type from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        where c.oid = to_regclass($1) and a.grantee = 0
       union all
       select 'columna', a2.privilege_type
         from pg_attribute at cross join lateral aclexplode(at.attacl) a2
        where at.attrelid = to_regclass($1) and at.attnum > 0 and a2.grantee = 0`,
      [`public.${t}`],
    );
    expect(r.rows).toEqual([]);
    expect((await admin.query("select 1 from pg_class where oid = to_regclass($1)", [`public.${t}`])).rowCount, "la tabla existe").toBe(1);
  });

  it("contapp_registrador (dueño de interno.notificar) recibe solo lo justo: SELECT de preferencias y programacion; SELECT, INSERT y UPDATE de envios y avisos; nunca DELETE", async () => {
    const quePuede = async (t: string) => {
      const ok: string[] = [];
      for (const p of PRIVS) {
        const r = await admin.query("select has_table_privilege('contapp_registrador', $1, $2) as ok", [`public.${t}`, p]);
        if (r.rows[0].ok === true) ok.push(p);
      }
      return ok;
    };
    expect(await quePuede("correo_preferencia")).toEqual(["SELECT"]);
    expect(await quePuede("correo_programacion")).toEqual(["SELECT"]);
    expect(await quePuede("correo_envio")).toEqual(["SELECT", "INSERT", "UPDATE"]);
    expect(await quePuede("correo_envio_aviso")).toEqual(["SELECT", "INSERT", "UPDATE"]);
  });

  it.each(["contapp_backend", "contapp_worker"])("%s no puede escribir directo ninguna tabla de correo (INSERT, UPDATE y DELETE: 42501)", async (rol) => {
    const db = rol === "contapp_backend" ? backend : worker;
    const ctx = rol === "contapp_backend" ? ctxB(X, uC) : ctxB(X);
    const hash = tokenNuevo().hash;
    const sentencias = [
      "insert into correo_preferencia (tenant_id, usuario_id, tipo, activo) values ($1, $2, 'plan_limite', true)",
      "update correo_preferencia set activo = false",
      "delete from correo_preferencia",
      "insert into correo_envio (tenant_id, usuario_id, origen, tipo, estado, clave, programado_para) values ($1, $2, 'aviso', 'buzon_critico', 'pendiente', 'x', now())",
      "update correo_envio set estado = 'enviado'",
      "update correo_envio set total_avisos = 99",
      "delete from correo_envio",
      "insert into correo_envio_aviso (tenant_id, notificacion_id, usuario_id, tipo, diferido_en) values ($1, gen_random_uuid(), $2, 'buzon_critico', now())",
      "update correo_envio_aviso set envio_id = null",
      "delete from correo_envio_aviso",
      "insert into correo_baja_token (tenant_id, hash, usuario_id, tipo, envio_id, vence_en) values ($1, $3, $2, 'resumen', gen_random_uuid(), now())",
      "update correo_baja_token set vence_en = now() + interval '1 year'",
      "delete from correo_baja_token",
      "update correo_programacion set tope_diario = 500",
      "delete from correo_programacion",
    ];
    for (const sql of sentencias) {
      const valores = sql.includes("$3") ? [X, uC, hash] : sql.includes("$1") ? [X, uC] : [];
      rechazo(await intentar(db, ctx, sql, valores), "42501");
    }
  });

  it("los tokens de baja y la programacion no se pueden ni leer desde la app (42501); el backend tampoco lee los avisos", async () => {
    for (const [db, ctx] of [
      [backend, ctxB(X, uC)],
      [worker, ctxB(X)],
    ] as const) {
      rechazo(await intentar(db, ctx, "select * from correo_baja_token"), "42501");
      rechazo(await intentar(db, ctx, "select * from correo_programacion"), "42501");
    }
    rechazo(await intentar(backend, ctxB(X, uC), "select * from correo_envio_aviso"), "42501");
  });

  it("contapp_app, contapp_platform y contapp_enumerador no leen nada de correo (42501)", async () => {
    for (const rol of ROLES_SIN_ACCESO) {
      for (const t of TABLAS_CORREO) {
        const r = await enTx(admin, rol, (c) => probar(c, `select 1 from ${t} limit 1`));
        rechazo(r, "42501");
      }
    }
  });
});

// ---- aislamiento por RLS ------------------------------------------------------------------------------------------------------
describe("RLS: cada estudio y cada usuario ve solo lo suyo (CA-1, CA-5)", () => {
  const distintos = (rows: Record<string, unknown>[], col: string) => [...new Set(rows.map((r) => String(r[col])))].sort();

  it("el worker de X ve las preferencias, envios y avisos de X y nada de Y (y viceversa)", async () => {
    for (const [t, otro] of [
      [X, Y],
      [Y, X],
    ] as const) {
      for (const tabla of ["correo_preferencia", "correo_envio", "correo_envio_aviso"]) {
        const f = await filas(worker, ctxB(t), `select * from ${tabla}`);
        expect(f.length, `${tabla} de ${t}`).toBeGreaterThan(0);
        expect(distintos(f, "tenant_id"), tabla).toEqual([t]);
        const ajenas = await filas(worker, ctxB(t), `select * from ${tabla} where tenant_id = '${otro}'`);
        expect(ajenas, `${tabla}: ${otro} desde ${t}`).toEqual([]);
      }
    }
  });

  it("sin estudio en la sesion (withSistema) el worker no ve ninguna fila de correo", async () => {
    for (const tabla of ["correo_preferencia", "correo_envio", "correo_envio_aviso"]) {
      const f = await sistema.withSistema(async (tx) => (await tx.query(`select * from ${tabla}`)).rows);
      expect(f, tabla).toEqual([]);
    }
  });

  it("el backend lee solo las preferencias del usuario de la sesion en el estudio activo, no las de otro usuario del mismo estudio", async () => {
    const propias = await filas(backend, ctxB(X, uC), "select * from correo_preferencia");
    expect(propias.length).toBeGreaterThan(0);
    expect(distintos(propias, "usuario_id")).toEqual([uC]);
    expect(distintos(propias, "tenant_id")).toEqual([X]);
    const delDueno = await filas(backend, ctxB(X, uC), `select * from correo_preferencia where usuario_id = '${uD}'`);
    expect(delDueno).toEqual([]);
    expect(distintos(await filas(backend, ctxB(X, uD), "select * from correo_preferencia"), "usuario_id")).toEqual([uD]);
  });

  it("el backend lee solo los envios del usuario de la sesion", async () => {
    const f = await filas(backend, ctxB(X, uC), "select * from correo_envio");
    expect(f.map((x) => x.id)).toEqual([envC]);
    expect(await filas(backend, ctxB(X, uC), `select * from correo_envio where usuario_id = '${uD}'`)).toEqual([]);
  });

  it("un usuario en dos estudios ve en cada uno solo las filas de ese estudio (CA-5)", async () => {
    for (const t of [X, Y]) {
      for (const tabla of ["correo_preferencia", "correo_envio"]) {
        const f = await filas(backend, ctxB(t, uXY), `select * from ${tabla}`);
        expect(f.length, `${tabla} en ${t}`).toBeGreaterThan(0);
        expect(distintos(f, "tenant_id")).toEqual([t]);
        expect(distintos(f, "usuario_id")).toEqual([uXY]);
      }
    }
  });

  it("un usuario de otro estudio no ve las filas de X aunque conozca los ids; sin usuario en la sesion el backend no ve nada", async () => {
    expect(await filas(backend, ctxB(Y, uY), `select * from correo_envio where id = '${envC}'`)).toEqual([]);
    expect(await filas(backend, ctxB(Y, uC), "select * from correo_preferencia")).toEqual([]); // uC no es de Y
    for (const tabla of ["correo_preferencia", "correo_envio"]) {
      expect(await filas(backend, ctxB(X), `select * from ${tabla}`), `${tabla} sin app.user_id`).toEqual([]);
    }
  });
});

// ---- CHECK, unicas y claves foraneas -------------------------------------------------------------------------------------------
describe("CHECK, unicas y FK (R-11, D-2)", () => {
  /** Sentencia del superusuario en una transaccion que se revierte; `app.tenant_id` fijado para los defaults. */
  const probarAdmin = (sql: string, valores: unknown[] = []) =>
    enTx(admin, null, async (c) => {
      await c.query("select set_config('app.tenant_id', $1, true)", [X]);
      return probar(c, sql, valores);
    });

  const pref = (tipo: string, todos = false, usuario = uC, tenant = X) =>
    probarAdmin(
      "insert into correo_preferencia (tenant_id, usuario_id, tipo, activo, todos_clientes) values ($1, $2, $3, true, $4)",
      [tenant, usuario, tipo, todos],
    );

  it("correo_preferencia: el tipo debe ser uno de los cuatro; todos_clientes solo vale en `resumen`", async () => {
    rechazo(await pref("trabajo_terminado"), "23514");
    rechazo(await pref("otro"), "23514");
    rechazo(await pref("plan_limite", true), "23514");
    rechazo(await pref("buzon_critico", true), "23514");
    expect((await pref("plan_limite", false)).ok).toBe(true);
    expect((await pref("resumen", true, uD)).ok).toBe(true);
  });

  it("correo_preferencia: PK por (estudio, usuario, tipo) y FK a la membresia del estudio", async () => {
    rechazo(await pref("buzon_critico"), "23505"); // uC ya tiene buzon_critico en X
    rechazo(await pref("plan_limite", false, uY, X), "23503"); // uY no es miembro de X
    rechazo(await pref("plan_limite", false, randomUUID(), X), "23503");
  });

  it("correo_preferencia: tenant_id toma por omision el estudio de la sesion", async () => {
    const r = await enTx(admin, null, async (c) => {
      await c.query("select set_config('app.tenant_id', $1, true)", [X]);
      await c.query("insert into correo_preferencia (usuario_id, tipo, activo) values ($1, 'plan_limite', true)", [uC]);
      return (await c.query("select tenant_id from correo_preferencia where usuario_id = $1 and tipo = 'plan_limite'", [uC])).rows[0];
    });
    expect(r.tenant_id).toBe(X);
  });

  const nuevoEnvio = (o: Record<string, unknown> = {}) => {
    const v = {
      usuario: uC,
      origen: "aviso",
      tipo: "buzon_critico",
      estado: "pendiente",
      motivo: null,
      clave: `aviso:${uC}:${randomUUID()}`,
      tomado: false,
      tenant: X,
      ...o,
    };
    return probarAdmin(
      `insert into correo_envio (tenant_id, usuario_id, origen, tipo, estado, motivo, clave, programado_para, intentos, total_avisos, tomado_en)
       values ($1, $2, $3, $4, $5, $6, $7, now(), case when $8::boolean then 1 else 0 end, 1, case when $8::boolean then now() else null end)`,
      [v.tenant, v.usuario, v.origen, v.tipo, v.estado, v.motivo, v.clave, v.tomado],
    );
  };

  it("correo_envio: origen, tipo, estado y motivo salen de las listas cerradas", async () => {
    rechazo(await nuevoEnvio({ origen: "manual" }), "23514");
    rechazo(await nuevoEnvio({ tipo: "trabajo_terminado" }), "23514");
    rechazo(await nuevoEnvio({ estado: "enviando" }), "23514");
    rechazo(await nuevoEnvio({ estado: "omitido", motivo: "porque_si" }), "23514");
    for (const origen of ["aviso", "resumen", "pendientes"]) {
      expect((await nuevoEnvio({ origen, tipo: origen === "resumen" ? "resumen" : "buzon_critico", estado: "enviado" })).ok, origen).toBe(true);
    }
    for (const motivo of ["membresia_inactiva", "sin_correo", "preferencia_apagada", "sin_plan", "sin_contenido", "sin_novedades"]) {
      expect((await nuevoEnvio({ estado: "omitido", motivo })).ok, motivo).toBe(true);
    }
    expect((await nuevoEnvio({ estado: "fallido", motivo: "transporte" })).ok).toBe(true);
  });

  it("correo_envio: la clave es unica por estudio y el usuario debe ser miembro del estudio", async () => {
    const existente = (await admin.query("select clave from correo_envio where id = $1", [envC])).rows[0].clave as string;
    rechazo(await nuevoEnvio({ clave: existente, estado: "enviado" }), "23505");
    rechazo(await nuevoEnvio({ usuario: uY }), "23503");
    // la misma clave en OTRO estudio no choca (la unica es por estudio)
    const otraY = (await admin.query("select clave from correo_envio where id = $1", [envY])).rows[0].clave as string;
    expect((await nuevoEnvio({ clave: otraY, usuario: uC, estado: "enviado" })).ok).toBe(true);
  });

  it("correo_envio: un solo `pendiente` sin tomar por (usuario, tipo) de origen aviso (D-2); tomado, otro tipo, otro usuario u otro origen no chocan", async () => {
    // uC ya tiene uno pendiente sin tomar de buzon_critico
    rechazo(await nuevoEnvio({}), "23505");
    expect((await nuevoEnvio({ tomado: true })).ok, "uno ya tomado").toBe(true);
    expect((await nuevoEnvio({ estado: "enviado" })).ok, "uno ya enviado").toBe(true);
    expect((await nuevoEnvio({ tipo: "credencial_invalida" })).ok, "otro tipo").toBe(true);
    rechazo(await nuevoEnvio({ usuario: uD }), "23505"); // uD tambien tiene el suyo
    expect((await nuevoEnvio({ usuario: uD, tipo: "credencial_invalida" })).ok, "otro usuario, otro tipo").toBe(true);
    expect((await nuevoEnvio({ origen: "resumen", tipo: "resumen" })).ok, "origen resumen").toBe(true);
    expect((await nuevoEnvio({ origen: "pendientes" })).ok, "origen pendientes").toBe(true);
  });

  it("correo_envio_aviso: hay que dar el envio o el instante de diferido; la notificacion y el envio son del mismo estudio", async () => {
    const nuevoAviso = (o: { notif?: string; envio?: string | null; diferido?: boolean; tenant?: string; usuario?: string }) =>
      probarAdmin(
        `insert into correo_envio_aviso (tenant_id, notificacion_id, usuario_id, tipo, envio_id, diferido_en)
         values ($1, $2, $3, 'buzon_critico', $4, case when $5::boolean then now() else null end)`,
        [o.tenant ?? X, o.notif ?? notifC, o.usuario ?? uC, o.envio ?? null, o.diferido ?? false],
      );
    const otraNotif = await ec.notificar(X, uC, { tipo: "buzon_critico", params: { categoria: "coactiva", mensajeId: randomUUID() } });
    rechazo(await nuevoAviso({ notif: otraNotif }), "23514"); // sin envio ni diferido
    expect((await nuevoAviso({ notif: otraNotif, diferido: true })).ok).toBe(true);
    expect((await nuevoAviso({ notif: otraNotif, envio: envC })).ok).toBe(true);
    rechazo(await nuevoAviso({ notif: notifC, envio: envC }), "23505"); // PK (estudio, notificacion)
    rechazo(await nuevoAviso({ notif: otraNotif, envio: envY }), "23503"); // envio de otro estudio
    rechazo(await nuevoAviso({ notif: notifY, diferido: true, usuario: uC }), "23503"); // notificacion de otro estudio
    rechazo(await nuevoAviso({ notif: otraNotif, diferido: true, tenant: Y, usuario: uY }), "23503"); // notificacion de X con estudio Y
  });

  it("correo_baja_token: hash de 32 bytes, unico, ligado a un envio del mismo estudio", async () => {
    const insertar = (hash: Buffer, envioId = envC, tenant = X) =>
      probarAdmin(
        "insert into correo_baja_token (tenant_id, hash, usuario_id, tipo, envio_id, vence_en) values ($1, $2, $3, 'buzon_critico', $4, now() + interval '90 days')",
        [tenant, hash, uC, envioId],
      );
    rechazo(await insertar(Buffer.alloc(31, 1)), "23514");
    rechazo(await insertar(Buffer.alloc(33, 1)), "23514");
    expect((await insertar(tokenNuevo().hash)).ok).toBe(true);
    const existente = (await admin.query("select hash from correo_baja_token where tenant_id = $1 limit 1", [X])).rows[0].hash as Buffer;
    rechazo(await insertar(existente), "23505");
    rechazo(await insertar(tokenNuevo().hash, envY), "23503");
  });

  it("correo_programacion: una sola fila y limites de ventana (1..60) y tope (1..500)", async () => {
    const r = await enTx(admin, null, async (c) => {
      const otra = await probar(c, "insert into correo_programacion select * from correo_programacion");
      const out: Record<string, { ok: boolean; code?: string }> = { otra };
      for (const [k, v] of [
        ["ventana_cero", "ventana_min = 0"],
        ["ventana_61", "ventana_min = 61"],
        ["tope_cero", "tope_diario = 0"],
        ["tope_501", "tope_diario = 501"],
      ] as const) {
        out[k] = await probar(c, `update correo_programacion set ${v}`);
      }
      out.ventana_60 = await probar(c, "update correo_programacion set ventana_min = 60");
      out.tope_500 = await probar(c, "update correo_programacion set tope_diario = 500");
      return out;
    });
    expect(r.otra!.ok).toBe(false);
    expect(["23505", "23514"]).toContain((r.otra as { code: string }).code);
    for (const k of ["ventana_cero", "ventana_61", "tope_cero", "tope_501"]) rechazo(r[k]!, "23514");
    expect(r.ventana_60!.ok).toBe(true);
    expect(r.tope_500!.ok).toBe(true);
  });
});
