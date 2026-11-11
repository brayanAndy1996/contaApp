// Spec 017 (T3, rojo): tabla `notificacion` y `plan_aviso` en BD real (D-8, D-13; CA-7, CA-11). RLS por estudio y por
// usuario, grants por columna, CHECK, deduplicacion y funciones nuevas con sus privilegios. Falla hoy por tabla o funcion
// ausente (migracion 0043 de T7). Contrato en notificaciones-soporte.ts.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enRollback, intentar, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  columnasConPriv,
  crearDb,
  EscenarioNotif,
  privTabla,
  ROLES_APP_BD,
  TIPOS_NOTIFICACION,
} from "./notificaciones-soporte";

let admin: Pool;
let en: EscenarioNotif;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let u1: string;
let u2: string;
let u3: string;
let n1: string;
let n2: string;
let n3: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  en = new EscenarioNotif(admin);
  X = (await en.estudio()).id;
  Y = (await en.estudio()).id;
  u1 = (await en.et.miembro(X, "contador")).id;
  u2 = (await en.et.miembro(X, "contador")).id;
  u3 = (await en.et.miembro(Y, "contador")).id;
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 2);
});
afterAll(async () => {
  await en?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

// Las notificaciones se siembran de forma perezosa: mientras la tabla no exista, cada prueba falla por su cuenta (rojo legible).
let sembrado: Promise<void> | undefined;
const sembrar = (): Promise<void> =>
  (sembrado ??= (async () => {
    n1 = await en.notificar(X, u1);
    n2 = await en.notificar(X, u2);
    n3 = await en.notificar(Y, u3);
  })());

const ids = async (ctx: { tenantId: string; userId?: string }): Promise<string[]> =>
  (
    await enRollback(backend, ctx, async (tx) => (await tx.query("select id from notificacion order by id")).rows)
  ).map((r: { id: string }) => r.id);

describe("RLS: cada usuario ve solo lo suyo (D-8, CA-7)", () => {
  it("el backend ve solo las notificaciones de su usuario en su estudio", async () => {
    await sembrar();
    expect(await ids({ tenantId: X, userId: u1 })).toEqual([n1]);
    expect(await ids({ tenantId: X, userId: u2 })).toEqual([n2]);
    expect(await ids({ tenantId: Y, userId: u3 })).toEqual([n3]);
  });

  it("un usuario de otro estudio con el contexto de X no ve nada de X ni de Y", async () => {
    await sembrar();
    expect(await ids({ tenantId: X, userId: u3 })).toEqual([]);
    expect(await ids({ tenantId: Y, userId: u1 })).toEqual([]);
  });

  it("sin usuario en el contexto no se ve nada (falla cerrado)", async () => {
    await sembrar();
    expect(await ids({ tenantId: X })).toEqual([]);
  });

  it("el worker no puede leerlas: 42501", async () => {
    await sembrar();
    const r = await intentar(worker, { tenantId: X }, "select id from notificacion");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("42501");
  });
});

describe("UPDATE solo de leida_en y solo de NULL a un valor (D-8)", () => {
  it("el destinatario marca la suya como leida; el valor queda fijado", async () => {
    await sembrar();
    const leida = await enRollback(backend, { tenantId: X, userId: u1 }, async (tx) => {
      const r = await tx.query("update notificacion set leida_en = now() where id = $1", [n1]);
      const f = await tx.query("select leida_en from notificacion where id = $1", [n1]);
      return { n: r.rowCount, leida: f.rows[0].leida_en };
    });
    expect(leida.n).toBe(1);
    expect(leida.leida).toBeInstanceOf(Date);
  });

  it("otro usuario del estudio no actualiza la de u1: 0 filas y sin cambios", async () => {
    await sembrar();
    const r = await intentar(backend, { tenantId: X, userId: u2 }, "update notificacion set leida_en = now() where id = $1", [
      n1,
    ]);
    expect(r).toEqual({ ok: true, rowCount: 0 });
    expect((await en.notifs(X, { usuarioId: u1 }))[0].leida_en).toBeNull();
  });

  it("un usuario de otro estudio tampoco: 0 filas", async () => {
    await sembrar();
    const r = await intentar(backend, { tenantId: Y, userId: u3 }, "update notificacion set leida_en = now() where id = $1", [
      n1,
    ]);
    expect(r).toEqual({ ok: true, rowCount: 0 });
    const s = await intentar(backend, { tenantId: X, userId: u3 }, "update notificacion set leida_en = now() where id = $1", [
      n1,
    ]);
    expect(s).toEqual({ ok: true, rowCount: 0 });
  });

  it.each(["tipo", "params", "usuario_id", "tenant_id", "creada_en", "cliente_id", "trabajo_id", "clave_dedupe"])(
    "actualizar la columna %s con el rol backend: 42501",
    async (col) => {
      await sembrar();
      const valor: Record<string, string> = {
        tipo: "'plan_limite'",
        params: "'{}'::jsonb",
        usuario_id: `'${u2}'::uuid`,
        tenant_id: `'${Y}'::uuid`,
        creada_en: "now()",
        cliente_id: "null",
        trabajo_id: "null",
        clave_dedupe: "'otra'",
      };
      const r = await intentar(backend, { tenantId: X, userId: u1 }, `update notificacion set ${col} = ${valor[col]} where id = $1`, [
        n1,
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    },
  );

  it("leida_en solo admite NULL -> valor: volver a NULL o cambiar el valor ya fijado falla", async () => {
    await sembrar();
    const leida = await en.notificar(X, u1, { leida: true });
    const aNulo = await intentar(backend, { tenantId: X, userId: u1 }, "update notificacion set leida_en = null where id = $1", [
      leida,
    ]);
    expect(aNulo.ok).toBe(false);
    const otraFecha = await intentar(
      backend,
      { tenantId: X, userId: u1 },
      "update notificacion set leida_en = now() + interval '1 hour' where id = $1",
      [leida],
    );
    expect(otraFecha.ok).toBe(false);
    // y no cambio nada
    const f = (await en.notifs(X, { usuarioId: u1 })).find((x) => x.id === leida);
    expect(f?.leida_en).toBeInstanceOf(Date);
    expect(f ? f.leida_en!.getTime() <= Date.now() : false).toBe(true);
  });
});

describe("sin INSERT, DELETE ni TRUNCATE para los roles de la app (D-8, Privilegios)", () => {
  it("el backend: INSERT, DELETE y TRUNCATE dan 42501", async () => {
    await sembrar();
    const ins = await intentar(
      backend,
      { tenantId: X, userId: u1 },
      `insert into notificacion (tenant_id, usuario_id, tipo, params, clave_dedupe)
       values ($1, $2, 'plan_limite', '{}'::jsonb, 'colada')`,
      [X, u1],
    );
    expect(ins.ok).toBe(false);
    if (!ins.ok) expect(ins.code).toBe("42501");
    const del = await intentar(backend, { tenantId: X, userId: u1 }, "delete from notificacion where id = $1", [n1]);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.code).toBe("42501");
    const tru = await intentar(backend, { tenantId: X, userId: u1 }, "truncate notificacion");
    expect(tru.ok).toBe(false);
    if (!tru.ok) expect(tru.code).toBe("42501");
    expect((await en.notifs(X, { usuarioId: u1 })).map((x) => x.id)).toContain(n1);
  });

  it.each(ROLES_APP_BD)("%s: ningun INSERT, DELETE, TRUNCATE, REFERENCES ni TRIGGER sobre notificacion", async (rol) => {
    for (const p of ["INSERT", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      expect(await privTabla(admin, rol, "notificacion", p), `${rol} ${p}`).toBe(false);
    }
    expect(await columnasConPriv(admin, rol, "notificacion", "INSERT"), `${rol} INSERT (col)`).toEqual([]);
  });

  it("el backend lee la tabla y actualiza SOLO la columna leida_en", async () => {
    expect(await privTabla(admin, "contapp_backend", "notificacion", "SELECT")).toBe(true);
    expect(await privTabla(admin, "contapp_backend", "notificacion", "UPDATE")).toBe(false);
    expect(await columnasConPriv(admin, "contapp_backend", "notificacion", "UPDATE")).toEqual(["leida_en"]);
  });

  it.each(["contapp_worker", "contapp_app", "contapp_platform"])("%s no tiene ningun grant sobre notificacion", async (rol) => {
    for (const p of ["SELECT", "UPDATE"]) {
      expect(await privTabla(admin, rol, "notificacion", p), `${rol} ${p} (tabla)`).toBe(false);
      expect(await columnasConPriv(admin, rol, "notificacion", p), `${rol} ${p} (col)`).toEqual([]);
    }
  });
});

describe("plan_aviso: estado interno sin grants (plan, 0043)", () => {
  it.each(ROLES_APP_BD)("%s no tiene ningun privilegio sobre plan_aviso", async (rol) => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      expect(await privTabla(admin, rol, "plan_aviso", p), `${rol} ${p} (tabla)`).toBe(false);
    }
    for (const p of ["SELECT", "INSERT", "UPDATE"]) {
      expect(await columnasConPriv(admin, rol, "plan_aviso", p), `${rol} ${p} (col)`).toEqual([]);
    }
  });

  it("el backend recibe 42501 al leer plan_aviso aunque fije su estudio", async () => {
    const r = await intentar(backend, { tenantId: X, userId: u1 }, "select * from plan_aviso");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("42501");
  });

  it("columnas: PK (tenant_id, recurso, umbral) con recurso y umbral acotados", async () => {
    const cols = (
      await admin.query(
        `select column_name from information_schema.columns where table_name = 'plan_aviso' and table_schema = 'public'
          order by column_name`,
      )
    ).rows.map((r) => r.column_name);
    expect(cols).toEqual(["alcanzado", "ciclo", "recurso", "tenant_id", "umbral"]);
    const pk = await admin.query(
      `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'public.plan_aviso'::regclass and i.indisprimary order by a.attname`,
    );
    expect(pk.rows.map((r) => r.attname)).toEqual(["recurso", "tenant_id", "umbral"]);
  });
});

describe("RLS forzada en las dos tablas (D-13)", () => {
  it.each(["notificacion", "plan_aviso"])("%s tiene RLS ENABLE y FORCE", async (tabla) => {
    const r = await admin.query("select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass", [
      `public.${tabla}`,
    ]);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("notificacion: sus politicas SELECT y UPDATE exigen estudio y usuario del contexto", async () => {
    const r = await admin.query(
      "select cmd, qual from pg_policies where schemaname = 'public' and tablename = 'notificacion' order by cmd",
    );
    const cmds = r.rows.map((x) => x.cmd);
    expect(cmds).toContain("SELECT");
    expect(cmds).toContain("UPDATE");
    expect(cmds).not.toContain("INSERT");
    expect(cmds).not.toContain("DELETE");
    for (const p of r.rows) {
      expect(p.qual).toContain("tenant_id");
      expect(p.qual).toContain("usuario_id");
      expect(p.qual).toContain("app.user_id");
    }
  });
});

describe("CHECK y deduplicacion (D-8; inundar las notificaciones)", () => {
  const insertar = (o: { tipo?: string; params?: string; clave?: string; usuario?: string; tenant?: string }) =>
    admin
      .query(
        `insert into notificacion (tenant_id, usuario_id, tipo, params, clave_dedupe)
         values ($1, $2, $3, $4::jsonb, $5)`,
        [o.tenant ?? X, o.usuario ?? u1, o.tipo ?? "trabajo_terminado", o.params ?? "{}", o.clave ?? randomUUID()],
      )
      .then(
        () => ({ ok: true as const }),
        (e: { code?: string }) => ({ ok: false as const, code: String(e.code) }),
      );

  it.each(TIPOS_NOTIFICACION)("acepta el tipo %s (buzon_critico queda reservado para R2)", async (tipo) => {
    expect(await insertar({ tipo })).toEqual({ ok: true });
  });

  it("rechaza un tipo fuera del catalogo: 23514", async () => {
    expect(await insertar({ tipo: "otro_tipo" })).toEqual({ ok: false, code: "23514" });
  });

  it("params debe ser un objeto: rechaza un arreglo, un numero y un texto", async () => {
    for (const params of ["[]", "1", '"texto"', "null"]) {
      expect(await insertar({ params }), params).toEqual({ ok: false, code: "23514" });
    }
  });

  it("params de mas de 1024 bytes: 23514; uno que cabe entra", async () => {
    const lleno = JSON.stringify({ x: "a".repeat(1100) });
    expect(await insertar({ params: lleno })).toEqual({ ok: false, code: "23514" });
    const cabe = JSON.stringify({ x: "a".repeat(1000) });
    expect(await insertar({ params: cabe })).toEqual({ ok: true });
  });

  it("la clave de deduplicacion es unica por (estudio, usuario): repetirla da 23505, otro usuario puede usarla", async () => {
    const clave = `dup:${randomUUID()}`;
    expect(await insertar({ clave })).toEqual({ ok: true });
    expect(await insertar({ clave })).toEqual({ ok: false, code: "23505" });
    expect(await insertar({ clave, usuario: u2 })).toEqual({ ok: true });
  });
});

describe("funciones nuevas: SECURITY DEFINER, search_path fijo y EXECUTE acotado (Privilegios)", () => {
  const FUNCIONES = [
    { firma: "notificaciones_de_esta_transaccion()", ejecutan: ["contapp_backend", "contapp_worker"] },
    { firma: "notificacion_purgar(integer)", ejecutan: ["contapp_worker"] },
    { firma: "plan_aviso_recalcular(uuid)", ejecutan: [] as string[] },
  ];

  it.each(FUNCIONES)("$firma es SECURITY DEFINER con search_path = pg_catalog, pg_temp", async ({ firma }) => {
    const r = await admin.query("select prosecdef, proconfig from pg_proc where oid = $1::regprocedure", [`public.${firma}`]);
    expect(r.rows[0].prosecdef).toBe(true);
    expect((r.rows[0].proconfig as string[]).map((s) => s.replace(/\s/g, ""))).toContain("search_path=pg_catalog,pg_temp");
  });

  it.each(FUNCIONES)("$firma: EXECUTE solo a $ejecutan (nunca a PUBLIC)", async ({ firma, ejecutan }) => {
    const puede = async (rol: string) =>
      (await admin.query("select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [rol, `public.${firma}`]))
        .rows[0].ok as boolean;
    expect(await puede("public")).toBe(false);
    for (const rol of ROLES_APP_BD) expect(await puede(rol), `${rol} ${firma}`).toBe(ejecutan.includes(rol));
  });
});
