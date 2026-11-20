// Spec 024 (T2, rojo): tablas de la atencion del buzon en BD real (D-5, D-12; CA-5, CA-10, CA-13). Catalogo (RLS FORCE, politica,
// columnas, indices), grants por rol y por columna, historial solo insercion (UPDATE y DELETE rechazados, 42501), FK compuesta al
// mensaje del mismo cliente y estudio, CHECK del comentario, aislamiento entre estudios y clasificacion historica al insertar y
// en la migracion 0059. Falla hoy porque las migraciones 0059-0060 aun no existen. El contrato esta en buzon-atencion-soporte.ts.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { columnasConPriv, privTabla } from "./notificaciones-soporte";
import { enRollback, intentar, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  comoRol,
  crearDb,
  EscenarioAtencion,
  enTx,
  insertarMensaje,
  probar,
  ROLES_EXEC,
  sembrarEvento,
  sqlMensajeAtencion,
  upsertEstado,
  type ClientePrueba,
} from "./buzon-atencion-soporte";

let admin: Pool;
let ea: EscenarioAtencion;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let uX: string; // contador de X
let uX2: string; // asistente de X
let uY: string; // contador de Y
let cx1: ClientePrueba;
let cx2: ClientePrueba;
let cy1: ClientePrueba;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ea = new EscenarioAtencion(admin);
  X = (await ea.estudio()).id;
  Y = (await ea.estudio()).id;
  uX = (await ea.et.miembro(X, "contador")).id;
  uX2 = (await ea.et.miembro(X, "asistente")).id;
  uY = (await ea.et.miembro(Y, "contador")).id;
  cx1 = await ea.et.cliente(X);
  cx2 = await ea.et.cliente(X);
  cy1 = await ea.et.cliente(Y);
  backend = crearDb("contapp_backend", 3);
  worker = crearDb("contapp_worker", 3);
});
afterAll(async () => {
  await ea?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const ctxB = () => ({ tenantId: X, userId: uX });
const ctxW = () => ({ tenantId: X });
const rechazo = (r: { ok: boolean; code?: string }, code: string) => {
  expect(r.ok, "la sentencia debia fallar").toBe(false);
  if (!r.ok) expect((r as { code: string }).code).toBe(code);
};

/** Mensajes y eventos sembrados una sola vez (confirmados) con el superusuario. */
let sembrado:
  | Promise<{ mx1: string; mx2: string; my1: string; e1: string; ey: string }>
  | undefined;
const sembrar = () =>
  (sembrado ??= (async () => {
    const mx1 = await insertarMensaje(admin, X, cx1.id, { idSunat: "A24-X1" });
    const mx2 = await insertarMensaje(admin, X, cx2.id, { idSunat: "A24-X2" });
    const my1 = await insertarMensaje(admin, Y, cy1.id, { idSunat: "A24-Y1" });
    const e1 = await sembrarEvento(admin, X, cx1.id, mx1, uX, {
      comentario: "Revisado con el cliente",
    });
    const ey = await sembrarEvento(admin, Y, cy1.id, my1, uY);
    return { mx1, mx2, my1, e1, ey };
  })());

const enAdmin = <T>(pasos: (c: PoolClient) => Promise<T>) =>
  enTx(admin, null, pasos);

describe("catalogo de buzon_atencion y de las columnas nuevas (D-5, D-12, CA-10)", () => {
  it("buzon_atencion tiene RLS ENABLE + FORCE, la politica tenant_isolation y tenant_id uuid NOT NULL", async () => {
    const c = await admin.query(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as forzada
         from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' where c.relname = 'buzon_atencion'`,
    );
    expect(c.rows[0], "buzon_atencion existe").toEqual({
      rls: true,
      forzada: true,
    });
    const p = await admin.query(
      "select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'buzon_atencion'",
    );
    expect(p.rows).toEqual([{ policyname: "tenant_isolation", cmd: "ALL" }]);
    const col = await admin.query(
      `select a.attnotnull as no_nula, t.typname as tipo from pg_attribute a join pg_type t on t.oid = a.atttypid
        where a.attrelid = 'public.buzon_atencion'::regclass and a.attname = 'tenant_id' and not a.attisdropped`,
    );
    expect(col.rows[0]).toEqual({ no_nula: true, tipo: "uuid" });
  });

  it("buzon_atencion tiene las columnas del plan y pertenece a contapp_migrator", async () => {
    const r = await admin.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'buzon_atencion'",
    );
    expect(r.rows.map((x) => x.column_name)).toEqual(
      expect.arrayContaining([
        "id",
        "tenant_id",
        "cliente_id",
        "mensaje_id",
        "accion",
        "comentario",
        "usuario_id",
        "creado_en",
      ]),
    );
    const d = await admin.query(
      "select pg_get_userbyid(relowner) as dueno from pg_class where oid = 'public.buzon_atencion'::regclass",
    );
    expect(d.rows[0].dueno).toBe("contapp_migrator");
  });

  it("buzon_mensaje suma historico (boolean NOT NULL DEFAULT false), atendido_en (timestamptz) y atendido_por (uuid)", async () => {
    const r = await admin.query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'buzon_mensaje'
          and column_name in ('historico', 'atendido_en', 'atendido_por') order by column_name`,
    );
    expect(r.rows).toEqual([
      {
        column_name: "atendido_en",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "atendido_por",
        data_type: "uuid",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "historico",
        data_type: "boolean",
        is_nullable: "NO",
        column_default: "false",
      },
    ]);
  });

  it("CHECK (atendido_en IS NULL) = (atendido_por IS NULL) y FK de atendido_por a usuario (23514, 23503)", async () => {
    const r = await enAdmin(async (c) => {
      const m = await insertarMensaje(c, X, cx1.id, {});
      return {
        soloFecha: await probar(
          c,
          "update buzon_mensaje set atendido_en = now() where id = $1",
          [m],
        ),
        soloUsuario: await probar(
          c,
          "update buzon_mensaje set atendido_por = $2 where id = $1",
          [m, uX],
        ),
        usuarioInexistente: await probar(
          c,
          "update buzon_mensaje set atendido_en = now(), atendido_por = $2 where id = $1",
          [m, randomUUID()],
        ),
        completo: await probar(
          c,
          "update buzon_mensaje set atendido_en = now(), atendido_por = $2 where id = $1",
          [m, uX],
        ),
      };
    });
    rechazo(r.soloFecha, "23514");
    rechazo(r.soloUsuario, "23514");
    rechazo(r.usuarioInexistente, "23503");
    expect(r.completo.ok).toBe(true);
  });

  it("los indices del plan existen: por estudio y fecha, parciales de pendientes y de criticos, por cliente e historial", async () => {
    const r = await admin.query(
      `select indexname, indexdef from pg_indexes where schemaname = 'public'
        and indexname in ('buzon_mensaje_bandeja_idx', 'buzon_mensaje_pendiente_idx', 'buzon_mensaje_critico_pendiente_idx',
                          'buzon_mensaje_cliente_pendiente_idx', 'buzon_atencion_mensaje_idx')`,
    );
    const def = Object.fromEntries(
      r.rows.map((x) => [x.indexname as string, x.indexdef as string]),
    );
    expect(Object.keys(def).sort()).toEqual([
      "buzon_atencion_mensaje_idx",
      "buzon_mensaje_bandeja_idx",
      "buzon_mensaje_cliente_pendiente_idx",
      "buzon_mensaje_critico_pendiente_idx",
      "buzon_mensaje_pendiente_idx",
    ]);
    expect(def.buzon_mensaje_bandeja_idx).toContain(
      "(tenant_id, fecha DESC, id DESC)",
    );
    expect(def.buzon_mensaje_bandeja_idx).not.toMatch(/WHERE/i);
    for (const n of [
      "buzon_mensaje_pendiente_idx",
      "buzon_mensaje_critico_pendiente_idx",
      "buzon_mensaje_cliente_pendiente_idx",
    ]) {
      expect(def[n], n).toMatch(/WHERE/i);
      expect(def[n], n).toMatch(/atendido_en IS NULL/);
      expect(def[n], n).toMatch(/NOT historico/);
    }
    expect(def.buzon_mensaje_critico_pendiente_idx).toMatch(/critico/);
    expect(def.buzon_mensaje_cliente_pendiente_idx).toContain(
      "(tenant_id, cliente_id, fecha DESC, id DESC)",
    );
    expect(def.buzon_mensaje_cliente_pendiente_idx).toMatch(
      /INCLUDE \(critico\)/,
    );
    expect(def.buzon_atencion_mensaje_idx).toContain(
      "(tenant_id, mensaje_id, creado_en, id)",
    );
  });

  it("existen los triggers buzon_atencion_inmutable (UPDATE y DELETE) y buzon_mensaje_atencion_inicial (BEFORE INSERT)", async () => {
    const r = await admin.query(
      `select t.tgname, c.relname, t.tgtype::int as tipo, t.tgenabled as habilitado
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal and t.tgname in ('buzon_atencion_inmutable', 'buzon_mensaje_atencion_inicial')
        order by t.tgname`,
    );
    expect(r.rows.map((x) => [x.tgname, x.relname, x.habilitado])).toEqual([
      ["buzon_atencion_inmutable", "buzon_atencion", "O"],
      ["buzon_mensaje_atencion_inicial", "buzon_mensaje", "O"],
    ]);
    const inmutable = r.rows[0].tipo as number;
    const inicial = r.rows[1].tipo as number;
    expect(inmutable & 1, "inmutable: por fila").toBe(1);
    expect(inmutable & 2, "inmutable: BEFORE").toBe(2);
    expect(inmutable & 8, "inmutable: DELETE").toBe(8);
    expect(inmutable & 16, "inmutable: UPDATE").toBe(16);
    expect(inicial & 2, "inicial: BEFORE").toBe(2);
    expect(inicial & 4, "inicial: INSERT").toBe(4);
  });

  it("la auditoria admite las acciones buzon.atendido y buzon.atencion_deshecha (CHECK auditoria_accion_valida)", async () => {
    const r = await enAdmin(async (c) => {
      const insertar = (accion: string) =>
        probar(
          c,
          `insert into auditoria (tenant_id, actor_tipo, usuario_id, accion, entidad, datos) values ($1, 'usuario', $2, $3, 'buzon_mensaje', '{}')`,
          [X, uX, accion],
        );
      return {
        atendido: await insertar("buzon.atendido"),
        deshecha: await insertar("buzon.atencion_deshecha"),
        otra: await insertar("buzon.inventada"),
      };
    });
    expect(r.atendido.ok).toBe(true);
    expect(r.deshecha.ok).toBe(true);
    rechazo(r.otra, "23514");
  });
});

describe("grants de la atencion (D-5): backend solo lee el historial; nadie escribe ni cambia el estado directamente", () => {
  it("contapp_backend tiene SELECT en buzon_atencion y ningun rol tiene INSERT, UPDATE, DELETE ni TRUNCATE", async () => {
    expect(
      await privTabla(admin, "contapp_backend", "buzon_atencion", "SELECT"),
    ).toBe(true);
    for (const rol of ROLES_EXEC) {
      for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        expect(
          await privTabla(admin, rol, "buzon_atencion", priv),
          `${rol} ${priv}`,
        ).toBe(false);
      }
    }
  });

  it("worker, app, platform y enumerador no tienen ningun privilegio sobre buzon_atencion", async () => {
    for (const rol of [
      "contapp_worker",
      "contapp_app",
      "contapp_platform",
      "contapp_enumerador",
    ]) {
      for (const priv of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "REFERENCES",
      ]) {
        expect(
          await privTabla(admin, rol, "buzon_atencion", priv),
          `${rol} ${priv}`,
        ).toBe(false);
      }
    }
  });

  it("nadie tiene UPDATE de historico, atendido_en ni atendido_por en buzon_mensaje (solo lo cambia la funcion acotada)", async () => {
    for (const rol of ROLES_EXEC) {
      const cols = await columnasConPriv(admin, rol, "buzon_mensaje", "UPDATE");
      for (const c of ["historico", "atendido_en", "atendido_por"])
        expect(cols, `${rol} UPDATE ${c}`).not.toContain(c);
    }
    // El UPDATE por columnas del worker de 023 no cambia.
    expect(
      await columnasConPriv(admin, "contapp_worker", "buzon_mensaje", "UPDATE"),
    ).toEqual([
      "contenido_bytes",
      "contenido_obtenido_en",
      "contenido_ruta",
      "leido_sunat",
      "ultima_captura_en",
    ]);
  });

  it("el backend lee el historial de su estudio pero no inserta, cambia ni borra eventos (42501)", async () => {
    const s = await sembrar();
    const filas = await enRollback(backend, ctxB(), async (tx) =>
      (await tx.query("select id from buzon_atencion")).rows.map((x) => x.id),
    );
    expect(filas).toContain(s.e1);
    rechazo(
      await intentar(
        backend,
        ctxB(),
        "insert into buzon_atencion (tenant_id, cliente_id, mensaje_id, accion, usuario_id) values ($1, $2, $3, 'atendido', $4)",
        [X, cx1.id, s.mx1, uX],
      ),
      "42501",
    );
    rechazo(
      await intentar(
        backend,
        ctxB(),
        "update buzon_atencion set comentario = 'x'",
      ),
      "42501",
    );
    rechazo(
      await intentar(backend, ctxB(), "delete from buzon_atencion"),
      "42501",
    );
  });

  it("el worker no lee, inserta, cambia ni borra eventos (42501)", async () => {
    const s = await sembrar();
    rechazo(
      await intentar(worker, ctxW(), "select count(*) from buzon_atencion"),
      "42501",
    );
    rechazo(
      await intentar(
        worker,
        ctxW(),
        "insert into buzon_atencion (tenant_id, cliente_id, mensaje_id, accion, usuario_id) values ($1, $2, $3, 'atendido', $4)",
        [X, cx1.id, s.mx1, uX],
      ),
      "42501",
    );
    rechazo(
      await intentar(
        worker,
        ctxW(),
        "update buzon_atencion set comentario = 'x'",
      ),
      "42501",
    );
    rechazo(
      await intentar(worker, ctxW(), "delete from buzon_atencion"),
      "42501",
    );
  });

  it("ni el backend ni el worker cambian historico, atendido_en ni atendido_por de un mensaje (42501)", async () => {
    const s = await sembrar();
    for (const [db, ctx] of [
      [backend, ctxB()],
      [worker, ctxW()],
    ] as const) {
      for (const set of [
        "historico = true",
        "atendido_en = now(), atendido_por = $2",
        "atendido_en = null, atendido_por = null",
      ]) {
        rechazo(
          await intentar(
            db,
            ctx,
            `update buzon_mensaje set ${set} where id = $1`,
            set.includes("$2") ? [s.mx1, uX] : [s.mx1],
          ),
          "42501",
        );
      }
    }
  });
});

describe("historial solo insercion (D-5, CA-5): UPDATE y DELETE rechazados incluso para el migrator no superusuario", () => {
  it("contapp_migrator (no superusuario): UPDATE y DELETE del historial dan 42501", async () => {
    const s = await sembrar();
    const r = await comoRol(admin, "contapp_migrator", X, async (c) => ({
      actualizar: await probar(
        c,
        "update buzon_atencion set comentario = 'cambiado' where id = $1",
        [s.e1],
      ),
      actualizarUsuario: await probar(
        c,
        "update buzon_atencion set usuario_id = $2 where id = $1",
        [s.e1, uX2],
      ),
      borrar: await probar(c, "delete from buzon_atencion where id = $1", [
        s.e1,
      ]),
      borrarTodo: await probar(c, "delete from buzon_atencion"),
    }));
    rechazo(r.actualizar, "42501");
    rechazo(r.actualizarUsuario, "42501");
    rechazo(r.borrar, "42501");
    rechazo(r.borrarTodo, "42501");
  });

  it("el superusuario no puede hacer UPDATE (siempre 42501) pero si DELETE (mantenimiento y limpieza)", async () => {
    const s = await sembrar();
    const r = await enAdmin(async (c) => ({
      actualizar: await probar(
        c,
        "update buzon_atencion set comentario = 'cambiado' where id = $1",
        [s.e1],
      ),
      borrar: await probar(c, "delete from buzon_atencion where id = $1", [
        s.e1,
      ]),
    }));
    rechazo(r.actualizar, "42501");
    expect(r.borrar).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("el evento sembrado sigue intacto tras los intentos", async () => {
    const s = await sembrar();
    const f = (
      await admin.query(
        "select comentario, usuario_id from buzon_atencion where id = $1",
        [s.e1],
      )
    ).rows[0];
    expect(f).toEqual({
      comentario: "Revisado con el cliente",
      usuario_id: uX,
    });
  });
});

describe("integridad del evento (D-5): FK compuesta al mensaje del mismo cliente y estudio, y CHECK de valores", () => {
  const insertar = (
    tenant: string,
    cliente: string,
    mensaje: string,
    usuario: string,
    accion = "atendido",
    comentario: string | null = null,
  ) => ({
    text: `insert into buzon_atencion (tenant_id, cliente_id, mensaje_id, accion, comentario, usuario_id)
           values ($1, $2, $3, $4, $5, $6)`,
    values: [tenant, cliente, mensaje, accion, comentario, usuario],
  });

  it("un evento con el mensaje de otro cliente o de otro estudio es imposible (23503); el correcto entra", async () => {
    const s = await sembrar();
    const r = await enAdmin(async (c) => {
      const p = async (...a: Parameters<typeof insertar>) => {
        const q = insertar(...a);
        return probar(c, q.text, q.values);
      };
      return {
        bien: await p(X, cx1.id, s.mx1, uX),
        otroCliente: await p(X, cx2.id, s.mx1, uX),
        otroEstudioMensaje: await p(X, cy1.id, s.my1, uX),
        estudioDeOtro: await p(Y, cy1.id, s.mx1, uY),
        clienteDeOtro: await p(X, cy1.id, s.mx1, uX),
        inexistente: await p(X, cx1.id, randomUUID(), uX),
        usuarioInexistente: await p(X, cx1.id, s.mx1, randomUUID()),
      };
    });
    expect(r.bien.ok).toBe(true);
    for (const k of [
      "otroCliente",
      "otroEstudioMensaje",
      "estudioDeOtro",
      "clienteDeOtro",
      "inexistente",
      "usuarioInexistente",
    ] as const)
      rechazo(r[k], "23503");
  });

  it("CHECK de la accion (atendido | deshecho) y del comentario (nulo, 1..500, sin controles ni bidi)", async () => {
    const s = await sembrar();
    const casos: [string, string, string | null, boolean][] = [
      ["accion deshecho", "deshecho", null, true],
      ["accion atendido con comentario", "atendido", "Listo", true],
      ["comentario de 500", "atendido", "a".repeat(500), true],
      ["comentario con salto de linea", "atendido", "linea 1\nlinea 2", true],
      ["accion inventada", "revisado", null, false],
      ["comentario vacio", "atendido", "", false],
      ["comentario de 501", "atendido", "a".repeat(501), false],
      ["control BEL", "atendido", "hola\u0007", false],
      ["control TAB", "atendido", "hola\tmundo", false],
      ["bidi U+202E", "atendido", "hola\u202Emundo", false],
      ["bidi U+2066", "atendido", "hola\u2066mundo", false],
      ["bidi U+2069", "atendido", "hola\u2069mundo", false],
      ["marca U+200E", "atendido", "hola\u200Emundo", false],
      ["marca U+061C", "atendido", "hola\u061Cmundo", false],
    ];
    const r = await enAdmin(async (c) => {
      const out: {
        nombre: string;
        esperado: boolean;
        res: Awaited<ReturnType<typeof probar>>;
      }[] = [];
      for (const [nombre, accion, comentario, esperado] of casos) {
        const q = insertar(X, cx1.id, s.mx1, uX, accion, comentario);
        out.push({ nombre, esperado, res: await probar(c, q.text, q.values) });
      }
      return out;
    });
    for (const x of r) {
      if (x.esperado) expect(x.res.ok, x.nombre).toBe(true);
      else {
        expect(x.res.ok, x.nombre).toBe(false);
        expect(x.res.code, x.nombre).toBe("23514");
      }
    }
  });
});

describe("aislamiento entre estudios (CA-10): sin withTenant no se ve nada y cada estudio ve solo su historial", () => {
  it("el backend de X ve sus eventos y no los de Y; el de Y al reves", async () => {
    const s = await sembrar();
    const ver = (tenantId: string, userId: string) =>
      enRollback(backend, { tenantId, userId }, async (tx) =>
        (await tx.query("select id from buzon_atencion")).rows.map((x) => x.id),
      );
    const deX = await ver(X, uX);
    const deY = await ver(Y, uY);
    expect(deX).toContain(s.e1);
    expect(deX).not.toContain(s.ey);
    expect(deY).toContain(s.ey);
    expect(deY).not.toContain(s.e1);
  });

  it("sin app.tenant_id (rol con SELECT, sin withTenant) la RLS FORCE deja cero filas", async () => {
    await sembrar();
    const n = await comoRol(
      admin,
      "contapp_backend",
      null,
      async (c) =>
        (await c.query("select count(*)::int as n from buzon_atencion")).rows[0]
          .n,
    );
    expect(n).toBe(0);
  });

  it("el backend de X no ve el historial del mensaje de Y ni siquiera pidiendolo por id", async () => {
    const s = await sembrar();
    const filas = await enRollback(
      backend,
      ctxB(),
      async (tx) =>
        (
          await tx.query(
            "select id from buzon_atencion where mensaje_id = $1",
            [s.my1],
          )
        ).rows,
    );
    expect(filas).toEqual([]);
  });
});

describe("historico decidido por la BD al insertar (D-12, CA-13)", () => {
  let nuevo: ClientePrueba;
  const ins = async (
    db: ContappDb,
    ctx: { tenantId: string; userId?: string },
    clienteId: string,
    o: Parameters<typeof sqlMensajeAtencion>[2] = {},
  ) => {
    const q = sqlMensajeAtencion(ctx.tenantId, clienteId, o);
    return enRollback(
      db,
      ctx,
      async (tx) =>
        (await tx.query(q.text, q.values)).rows[0] as {
          id: string;
          historico: boolean;
          atendido_en: Date | null;
          atendido_por: string | null;
        },
    );
  };

  it.each([
    ["sin fila de estado", false],
    ["con estado sin sincronizado_en", true],
  ])(
    "primera sincronizacion (%s): 29 dias queda pendiente y 31 dias queda historico",
    async (_nombre, conEstado) => {
      nuevo = await ea.et.cliente(X);
      if (conEstado)
        await upsertEstado(admin, X, nuevo.id, { capturaHace: "1 hour" });
      const reciente = await ins(worker, ctxW(), nuevo.id, {
        fechaHace: "29 days",
      });
      const antiguo = await ins(worker, ctxW(), nuevo.id, {
        fechaHace: "31 days",
      });
      expect(reciente.historico, "29 dias").toBe(false);
      expect(antiguo.historico, "31 dias").toBe(true);
      expect(antiguo.atendido_en).toBeNull();
      expect(antiguo.atendido_por).toBeNull();
    },
  );

  it("un cliente ya sincronizado: un mensaje de 400 dias queda pendiente", async () => {
    const c = await ea.et.cliente(X);
    await upsertEstado(admin, X, c.id, {
      capturaHace: "1 hour",
      sincronizadoHace: "1 day",
    });
    const m = await ins(worker, ctxW(), c.id, { fechaHace: "400 days" });
    expect(m.historico).toBe(false);
  });

  it("el worker manda historico, atendido_en y atendido_por y el trigger los ignora (cliente sincronizado, mensaje reciente)", async () => {
    const c = await ea.et.cliente(X);
    await upsertEstado(admin, X, c.id, {
      capturaHace: "1 hour",
      sincronizadoHace: "1 day",
    });
    const m = await ins(worker, ctxW(), c.id, {
      fechaHace: "2 days",
      historico: true,
      atendidoHace: "1 hour",
      atendidoPor: uX,
    });
    expect(m.historico, "no es historico").toBe(false);
    expect(m.atendido_en, "no llega atendido").toBeNull();
    expect(m.atendido_por).toBeNull();
  });

  it("el worker manda historico = false y atendido en la primera sincronizacion de un mensaje de 31 dias: queda historico y sin atender", async () => {
    const c = await ea.et.cliente(X);
    const m = await ins(worker, ctxW(), c.id, {
      fechaHace: "31 days",
      historico: false,
      atendidoHace: "1 hour",
      atendidoPor: uX,
    });
    expect(m.historico).toBe(true);
    expect(m.atendido_en).toBeNull();
    expect(m.atendido_por).toBeNull();
  });

  it("tambien el superusuario recibe la clasificacion de la BD (siembra): lo que mande no cambia el resultado", async () => {
    const c = await ea.et.cliente(X);
    const q = sqlMensajeAtencion(X, c.id, {
      fechaHace: "31 days",
      historico: false,
      atendidoHace: "1 hour",
      atendidoPor: uX,
    });
    const r = await enAdmin(
      async (cx) => (await cx.query(q.text, q.values)).rows[0],
    );
    expect(r.historico).toBe(true);
    expect(r.atendido_en).toBeNull();
    expect(r.atendido_por).toBeNull();
  });

  it("la funcion del trigger es SECURITY DEFINER de contapp_migrator, con search_path fijo y sin EXECUTE para PUBLIC", async () => {
    const r = await admin.query(
      `select p.prosecdef as secdef, coalesce(p.proconfig, '{}') as config, pg_get_userbyid(p.proowner) as dueno,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as publico
         from pg_proc p where p.oid = 'public.buzon_mensaje_atencion_inicial()'::regprocedure`,
    );
    expect(r.rows[0]).toEqual({
      secdef: true,
      config: ["search_path=pg_catalog, pg_temp"],
      dueno: "contapp_migrator",
      publico: false,
    });
  });
});

describe("la migracion 0059 reclasifica los mensajes de 023 como el aviso (D-12, CA-13)", () => {
  const dirMigraciones = fileURLToPath(
    new URL("../../packages/db/migrations/", import.meta.url),
  );

  it("sobre filas sembradas antes (historico = false) deja historico segun la regla y, en los criticos, igual a NOT avisado", async () => {
    const archivos = existsSync(dirMigraciones)
      ? readdirSync(dirMigraciones).filter((f) => /^0059_.*\.sql$/.test(f))
      : [];
    expect(archivos, "existe la migracion 0059_*.sql").toHaveLength(1);
    const sql = readFileSync(`${dirMigraciones}${archivos[0]}`, "utf8");

    const aj = await ea.et.cliente(X); // primera sincronizacion en curso: sin estado
    const bj = await ea.et.cliente(X); // se sincroniza despues de guardar los mensajes
    const cj = await ea.et.cliente(X); // ya sincronizado antes de que lleguen los mensajes
    await upsertEstado(admin, X, cj.id, {
      capturaHace: "3 days",
      sincronizadoHace: "2 days",
    });

    const filas = await enAdmin(async (c) => {
      const antiguoNoCritico = await insertarMensaje(c, X, aj.id, {
        fechaHace: "40 days",
      });
      const recienteNoCritico = await insertarMensaje(c, X, aj.id, {
        fechaHace: "10 days",
      });
      const criticoAntiguoSinAviso = await insertarMensaje(c, X, aj.id, {
        fechaHace: "40 days",
        critico: true,
        avisado: false,
      });
      const criticoRecienteAvisado = await insertarMensaje(c, X, aj.id, {
        fechaHace: "5 days",
        critico: true,
        avisado: true,
      });
      const entroEnLaPrimera = await insertarMensaje(c, X, bj.id, {
        fechaHace: "50 days",
        critico: true,
        avisado: false,
      });
      await upsertEstado(c, X, bj.id, {
        capturaHace: "0 seconds",
        sincronizadoHace: "0 seconds",
      });
      const entroDespues = await insertarMensaje(c, X, cj.id, {
        fechaHace: "400 days",
      });
      const criticoDespues = await insertarMensaje(c, X, cj.id, {
        fechaHace: "400 days",
        critico: true,
        avisado: true,
      });
      const ids = [
        antiguoNoCritico,
        recienteNoCritico,
        criticoAntiguoSinAviso,
        criticoRecienteAvisado,
        entroEnLaPrimera,
        entroDespues,
        criticoDespues,
      ];
      // Estado de 023: la columna nueva no existia y todo quedo en su valor por omision.
      await c.query(
        "update buzon_mensaje set historico = false where id = any($1::uuid[])",
        [ids],
      );
      // La migracion se repite sobre la BD ya migrada (db:migrate x2, CA-14); todo se revierte al final.
      await c.query(sql);
      const r = await c.query(
        "select id, historico, critico, avisado from buzon_mensaje where id = any($1::uuid[])",
        [ids],
      );
      const por = new Map(r.rows.map((x) => [x.id as string, x]));
      return {
        antiguoNoCritico: por.get(antiguoNoCritico),
        recienteNoCritico: por.get(recienteNoCritico),
        criticoAntiguoSinAviso: por.get(criticoAntiguoSinAviso),
        criticoRecienteAvisado: por.get(criticoRecienteAvisado),
        entroEnLaPrimera: por.get(entroEnLaPrimera),
        entroDespues: por.get(entroDespues),
        criticoDespues: por.get(criticoDespues),
      };
    });
    expect(
      filas.antiguoNoCritico.historico,
      "40 dias, primera sincronizacion",
    ).toBe(true);
    expect(filas.recienteNoCritico.historico, "10 dias").toBe(false);
    expect(filas.entroEnLaPrimera.historico, "entro antes de sincronizar").toBe(
      true,
    );
    expect(
      filas.entroDespues.historico,
      "entro con el cliente ya sincronizado",
    ).toBe(false);
    for (const k of [
      "criticoAntiguoSinAviso",
      "criticoRecienteAvisado",
      "entroEnLaPrimera",
      "criticoDespues",
    ] as const) {
      expect(filas[k].critico, k).toBe(true);
      expect(filas[k].historico, `${k}: critico historico = NOT avisado`).toBe(
        !filas[k].avisado,
      );
    }
  });
});
