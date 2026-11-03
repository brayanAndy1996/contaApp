// Spec 006 (T1, rojo): catalogo, privilegios, restricciones y seed de las tablas nuevas `plan`, `suscripcion`,
// `admin_plataforma`, `auth.registro_pendiente` y de `tenant.ruc_estudio` (CA-1, CA-2, CA-3, CA-7, CA-8; D1, D2, D5, D6).
// Contrato que fija (T5, migraciones NNNN_planes*.sql; plan.md "BD"):
// - plan / suscripcion / admin_plataforma en public, dueño contapp_migrator; suscripcion con tenant_id uuid NOT NULL, RLS
//   ENABLE+FORCE y tenant_isolation FOR SELECT (sin WITH CHECK), mas auth_definer (SELECT), auth_definer_insert y
//   auth_definer_update para contapp_auth. plan y admin_plataforma SIN tenant_id.
// - contapp_backend: SELECT de tabla en suscripcion; en plan SELECT solo por columna y NINGUNA de precio_* (leer
//   precios -> 42501); nada en admin_plataforma ni en auth.registro_pendiente; ningun INSERT/UPDATE/DELETE en las tres.
//   contapp_worker, contapp_platform, contapp_app y contapp_enumerador: sin ningun privilegio en las cuatro tablas.
// - contapp_auth: SELECT/INSERT/UPDATE en plan y suscripcion (sin DELETE ni TRUNCATE); SOLO SELECT en admin_plataforma;
//   SELECT/INSERT/UPDATE/DELETE en auth.registro_pendiente; INSERT en tenant solo por columna (nombre, ruc_estudio).
// - CHECK/UNIQUE/FK de plan.md; seed de los 5 planes de 01 §3 y backfill (estudios existentes -> corporativo/activa).
// - auth.limite_tasa.tipo admite 'registro_ip', 'registro_correo' y (0025, D15) 'registro_confirmar_ip'.
// Los nombres de las politicas y de las restricciones no se fijan; si, el SQLSTATE (23514 CHECK, 23505 UNIQUE, 23503 FK,
// 23502 NOT NULL, 42501 privilegios).
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, crearDb, FUNCIONES_AUTH_PLANES } from "./auth-soporte";
import { EscenarioPlanes, PLANES_SEED } from "./planes-soporte";
import type { ContappDb } from "./soporte";
import {
  abrirPool,
  enRollback,
  intentar,
  intentarRaw,
  semilla,
  tenantDe,
} from "./soporte";

let admin: Pool; // superusuario: catalogo y escrituras con rollback
let pool: Pool; // contapp_app (DATABASE_URL): SET LOCAL ROLE de las pruebas de privilegios
let ep: EscenarioPlanes;
const dbs: ContappDb[] = [];

beforeAll(() => {
  admin = abrirAdmin(4);
  pool = abrirPool(3);
  ep = new EscenarioPlanes(admin);
});
afterAll(async () => {
  await ep?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await pool?.end();
  await admin?.end();
});

const consulta = async (text: string, values: unknown[] = []) =>
  (await admin.query(text, values)).rows;
const dbBackend = (): ContappDb => {
  const d = crearDb("contapp_backend", 2);
  dbs.push(d);
  return d;
};
const A = () => tenantDe("A");
const B = () => tenantDe("B");
const PRIVS_TABLA = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;
const codigo = (r: { ok: boolean; code?: string }) =>
  r.ok ? "ok" : (r.code ?? "");

async function descripcion(esquema: string, tabla: string): Promise<string[]> {
  const r = await consulta(
    `select column_name, data_type, numeric_precision, numeric_scale, is_nullable
       from information_schema.columns where table_schema = $1 and table_name = $2 order by column_name`,
    [esquema, tabla],
  );
  return r.map(
    (c) =>
      `${c.column_name} ${c.data_type}${c.data_type === "numeric" ? `(${c.numeric_precision},${c.numeric_scale})` : ""} ${
        c.is_nullable === "YES" ? "NULL" : "NOT NULL"
      }`,
  );
}

// =================================================================================================
describe("esquema: plan, suscripcion, admin_plataforma, registro_pendiente y tenant.ruc_estudio (D1, D2, D3, D5)", () => {
  it("plan: columnas, tipos y nulabilidad del plan (precios numeric(14,2); max_usuarios NULL = ilimitado)", async () => {
    expect(await descripcion("public", "plan")).toEqual([
      "activo boolean NOT NULL",
      "codigo text NOT NULL",
      "created_at timestamp with time zone NOT NULL",
      "features jsonb NOT NULL",
      "frecuencia_buzon_min integer NOT NULL",
      "id uuid NOT NULL",
      "max_rucs integer NOT NULL",
      "max_rucs_extra integer NOT NULL",
      "max_usuarios integer NULL",
      "nombre text NOT NULL",
      "precio_anual numeric(14,2) NULL",
      "precio_mensual numeric(14,2) NOT NULL",
      "precio_ruc_extra numeric(14,2) NOT NULL",
      "updated_at timestamp with time zone NOT NULL",
    ]);
  });

  it("suscripcion: columnas, tipos y nulabilidad (prueba_vence_en NULL permitido solo fuera de 'prueba')", async () => {
    expect(await descripcion("public", "suscripcion")).toEqual([
      "created_at timestamp with time zone NOT NULL",
      "estado text NOT NULL",
      "id uuid NOT NULL",
      "plan_id uuid NOT NULL",
      "prueba_vence_en timestamp with time zone NULL",
      "rucs_extra_contratados integer NOT NULL",
      "tenant_id uuid NOT NULL",
      "updated_at timestamp with time zone NOT NULL",
    ]);
  });

  it("admin_plataforma(usuario_id PK -> usuario, created_at) sin tenant_id", async () => {
    expect(await descripcion("public", "admin_plataforma")).toEqual([
      "created_at timestamp with time zone NOT NULL",
      "usuario_id uuid NOT NULL",
    ]);
  });

  it("auth.registro_pendiente: solo el hash del token (bytea), vence_en, consumida_en y los datos del registro", async () => {
    expect(await descripcion("auth", "registro_pendiente")).toEqual([
      "consumida_en timestamp with time zone NULL",
      "correo text NOT NULL",
      "creada_en timestamp with time zone NOT NULL",
      "id uuid NOT NULL",
      "nombre_estudio text NOT NULL",
      "nombre_usuario text NOT NULL",
      "ruc_estudio text NULL",
      "token_hash bytea NOT NULL",
      "vence_en timestamp with time zone NOT NULL",
    ]);
  });

  it("tenant.ruc_estudio es text NULL (informativo, D2)", async () => {
    const r = await consulta(
      `select data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'tenant' and column_name = 'ruc_estudio'`,
    );
    expect(r).toEqual([{ data_type: "text", is_nullable: "YES" }]);
  });

  it.each(["plan", "suscripcion", "admin_plataforma"])(
    "public.%s: dueño contapp_migrator",
    async (t) => {
      const r = await consulta(
        "select o.rolname as dueno from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass($1)",
        [`public.${t}`],
      );
      expect(r).toEqual([{ dueno: "contapp_migrator" }]);
    },
  );

  it("plan.id y suscripcion.id usan uuid_v7() por defecto", async () => {
    const r = await consulta(
      `select table_name, column_default from information_schema.columns
        where table_schema = 'public' and table_name in ('plan', 'suscripcion') and column_name = 'id' order by 1`,
    );
    expect(r).toHaveLength(2);
    for (const c of r)
      expect(c.column_default, c.table_name).toContain("uuid_v7");
  });

  it("las 11 funciones auth.* de 006 existen, una firma cada una (privilegios y search_path: auth.spec.ts)", async () => {
    const r = await consulta(
      "select proname from pg_proc where pronamespace = to_regnamespace('auth') order by 1",
    );
    const nombres = r.map((x) => x.proname as string);
    for (const f of FUNCIONES_AUTH_PLANES)
      expect(
        nombres.filter((n) => n === f),
        f,
      ).toHaveLength(1);
  });
});

// =================================================================================================
describe("RLS de suscripcion (CA-1, CA-8)", () => {
  it("suscripcion: RLS ENABLE + FORCE", async () => {
    const r = await consulta(
      "select c.relrowsecurity as rls, c.relforcerowsecurity as forzada from pg_class c where c.oid = to_regclass('public.suscripcion')",
    );
    expect(r).toEqual([{ rls: true, forzada: true }]);
  });

  it("politicas de suscripcion: exactamente tenant_isolation (SELECT), auth_definer (SELECT), auth_definer_insert y auth_definer_update", async () => {
    const r = await consulta(
      `select policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies
        where schemaname = 'public' and tablename = 'suscripcion' order by policyname`,
    );
    expect(r.map((p) => p.policyname)).toEqual([
      "auth_definer",
      "auth_definer_insert",
      "auth_definer_update",
      "tenant_isolation",
    ]);
    const por = Object.fromEntries(r.map((p) => [p.policyname, p]));
    expect(por.tenant_isolation.cmd).toBe("SELECT");
    expect(por.tenant_isolation.qual).toContain("app.tenant_id");
    expect(por.tenant_isolation.with_check).toBeNull();
    expect(por.auth_definer).toMatchObject({
      cmd: "SELECT",
      roles: ["contapp_auth"],
      qual: "true",
    });
    expect(por.auth_definer_insert).toMatchObject({
      cmd: "INSERT",
      roles: ["contapp_auth"],
      with_check: "true",
    });
    expect(por.auth_definer_update).toMatchObject({
      cmd: "UPDATE",
      roles: ["contapp_auth"],
    });
  });

  it("el estudio A lee solo SU suscripcion (corporativo del backfill) y el B solo la suya", async () => {
    const db = dbBackend();
    for (const [ctx, esperado] of [
      [A(), A()],
      [B(), B()],
    ] as const) {
      const filas = await enRollback(
        db,
        { tenantId: ctx },
        async (tx) =>
          (await tx.query("select tenant_id, estado from suscripcion")).rows,
      );
      expect(filas.map((f) => f.tenant_id)).toEqual([esperado]);
    }
  });

  it("sin estudio activo (withUsuario) no se ve ninguna suscripcion", async () => {
    const db = dbBackend();
    const n = await db.withUsuario({ userId: semilla().uA }, async (tx) => {
      return Number(
        (await tx.query("select count(*)::int as n from suscripcion")).rows[0]
          .n,
      );
    });
    expect(n).toBe(0);
  });

  it("el estudio lee las columnas permitidas de su plan (limites, nombre, features, activo) mediante JOIN", async () => {
    const db = dbBackend();
    const filas = await enRollback(
      db,
      { tenantId: A() },
      async (tx) =>
        (
          await tx.query(
            `select p.codigo, p.nombre, p.max_rucs, p.max_usuarios, p.max_rucs_extra, p.frecuencia_buzon_min, p.features, p.activo
               from suscripcion s join plan p on p.id = s.plan_id`,
          )
        ).rows,
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      codigo: "corporativo",
      max_rucs: 600,
      max_usuarios: null,
      max_rucs_extra: 120,
      activo: true,
    });
  });
});

// =================================================================================================
describe("privilegios de contapp_backend (CA-1, CA-8: el backend de un estudio no lee precios ni escribe planes)", () => {
  it("suscripcion: SELECT de tabla; nada de INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ni TRIGGER (ni por columna)", async () => {
    const tiene = async (p: string) =>
      (
        await consulta(
          "select has_table_privilege('contapp_backend', 'public.suscripcion', $1) as v",
          [p],
        )
      )[0].v;
    expect(await tiene("SELECT")).toBe(true);
    for (const p of PRIVS_TABLA.filter((x) => x !== "SELECT"))
      expect(await tiene(p), p).toBe(false);
    for (const p of ["INSERT", "UPDATE", "REFERENCES"]) {
      const v = (
        await consulta(
          "select has_any_column_privilege('contapp_backend', 'public.suscripcion', $1) as v",
          [p],
        )
      )[0].v;
      expect(v, `columna ${p}`).toBe(false);
    }
  });

  it("plan: SELECT solo por columna y de ninguna precio_*; sin INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER", async () => {
    const cols = (
      await consulta(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'plan'",
      )
    ).map((c) => c.column_name as string);
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.filter((c) => c.startsWith("precio_")).sort()).toEqual([
      "precio_anual",
      "precio_mensual",
      "precio_ruc_extra",
    ]);
    for (const c of cols) {
      const v = (
        await consulta(
          "select has_column_privilege('contapp_backend', 'public.plan', $1, 'SELECT') as v",
          [c],
        )
      )[0].v;
      expect(v, `SELECT ${c}`).toBe(!c.startsWith("precio_"));
    }
    for (const p of PRIVS_TABLA) {
      const v = (
        await consulta(
          "select has_table_privilege('contapp_backend', 'public.plan', $1) as v",
          [p],
        )
      )[0].v;
      expect(v, `tabla ${p}`).toBe(false);
    }
    for (const p of ["INSERT", "UPDATE", "REFERENCES"]) {
      const v = (
        await consulta(
          "select has_any_column_privilege('contapp_backend', 'public.plan', $1) as v",
          [p],
        )
      )[0].v;
      expect(v, `columna ${p}`).toBe(false);
    }
  });

  it("admin_plataforma y auth.registro_pendiente: ningun privilegio (tabla ni columna)", async () => {
    for (const t of ["public.admin_plataforma", "auth.registro_pendiente"]) {
      for (const p of PRIVS_TABLA) {
        expect(
          (
            await consulta(
              "select has_table_privilege('contapp_backend', $1, $2) as v",
              [t, p],
            )
          )[0].v,
          `${t} ${p}`,
        ).toBe(false);
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        expect(
          (
            await consulta(
              "select has_any_column_privilege('contapp_backend', $1, $2) as v",
              [t, p],
            )
          )[0].v,
          `${t} ${p} (columna)`,
        ).toBe(false);
      }
    }
  });

  it.each([
    ["leer precio_mensual", "select precio_mensual from plan"],
    ["leer precio_anual", "select precio_anual from plan"],
    ["leer precio_ruc_extra", "select precio_ruc_extra from plan"],
    ["select * (incluye precios)", "select * from plan"],
    ["oraculo sobre un precio", "select 1 from plan where precio_mensual > 0"],
    [
      "precio por JOIN desde suscripcion",
      "select p.precio_mensual from suscripcion s join plan p on p.id = s.plan_id",
    ],
    [
      "ordenar por un precio",
      "select codigo from plan order by precio_mensual",
    ],
    ["leer admin_plataforma", "select usuario_id from admin_plataforma"],
    ["contar admin_plataforma", "select count(*) from admin_plataforma"],
    [
      "leer registro_pendiente",
      "select token_hash from auth.registro_pendiente",
    ],
    [
      "leer el correo de registro_pendiente",
      "select correo from auth.registro_pendiente",
    ],
  ])("permission denied (42501): %s", async (_n, sql) => {
    const r = await intentarRaw(pool, "contapp_backend", sql);
    expect(r.ok, "la sentencia debio rechazarse").toBe(false);
    expect(r.ok ? "" : r.code).toBe("42501");
  });

  it.each([
    [
      "INSERT en plan",
      "insert into plan (codigo, nombre, max_rucs, frecuencia_buzon_min, precio_mensual) values ('x', 'x', 1, 1, 0)",
    ],
    ["UPDATE de plan", "update plan set activo = false"],
    ["UPDATE de max_rucs de plan", "update plan set max_rucs = 100000"],
    ["DELETE de plan", "delete from plan"],
    ["TRUNCATE de plan", "truncate plan"],
    [
      "INSERT en suscripcion",
      "insert into suscripcion (plan_id, estado) select id, 'activa' from plan limit 1",
    ],
    [
      "UPDATE del plan de la suscripcion",
      "update suscripcion set plan_id = plan_id",
    ],
    [
      "UPDATE de rucs_extra_contratados",
      "update suscripcion set rucs_extra_contratados = 1000",
    ],
    ["DELETE de suscripcion", "delete from suscripcion"],
    ["TRUNCATE de suscripcion", "truncate suscripcion"],
    [
      "INSERT en admin_plataforma",
      "insert into admin_plataforma (usuario_id) select id from usuario limit 1",
    ],
    ["DELETE de admin_plataforma", "delete from admin_plataforma"],
    [
      "INSERT en registro_pendiente",
      "insert into auth.registro_pendiente default values",
    ],
    [
      "UPDATE de tenant.ruc_estudio",
      "update tenant set ruc_estudio = '20100070970'",
    ],
  ])("permission denied (42501): %s", async (_n, sql) => {
    const r = await intentarRaw(pool, "contapp_backend", sql);
    expect(r.ok, "la sentencia debio rechazarse").toBe(false);
    expect(r.ok ? "" : r.code).toBe("42501");
  });

  it("control: las columnas permitidas de plan se pueden leer como backend", async () => {
    const r = await intentarRaw(
      pool,
      "contapp_backend",
      "select id, codigo, nombre, max_rucs, max_usuarios, max_rucs_extra, frecuencia_buzon_min, features, activo, created_at, updated_at from plan",
    );
    expect(r.ok).toBe(true);
  });

  // CA-1: ni siquiera el Dueño de un estudio (con su contexto de withTenant) cambia el plan de su suscripcion ni un plan.
  it.each([
    [
      "cambiar el plan de su suscripcion",
      "update suscripcion set plan_id = (select id from plan where codigo = 'prueba')",
    ],
    [
      "subirse los RUCs adicionales",
      "update suscripcion set rucs_extra_contratados = 1000",
    ],
    ["borrar su suscripcion", "delete from suscripcion"],
    [
      "crear una suscripcion",
      "insert into suscripcion (plan_id, estado) select id, 'activa' from plan where codigo = 'corporativo'",
    ],
    [
      "editar los limites del plan",
      "update plan set max_rucs = 100000, max_usuarios = null",
    ],
    [
      "crear un plan",
      "insert into plan (codigo, nombre, precio_mensual, max_rucs, frecuencia_buzon_min) values ('regalo', 'Regalo', 0, 1000, 1)",
    ],
  ])("el Dueño del estudio A no puede %s (42501)", async (_n, sql) => {
    const r = await intentar(
      dbBackend(),
      { tenantId: A(), userId: semilla().uA },
      sql,
    );
    expect(codigo(r)).toBe("42501");
  });
});

// =================================================================================================
describe("otros roles sin acceso nuevo (contapp_worker, contapp_platform, contapp_app, contapp_enumerador)", () => {
  const TABLAS = [
    "public.plan",
    "public.suscripcion",
    "public.admin_plataforma",
    "auth.registro_pendiente",
  ];
  const ROLES = [
    "contapp_worker",
    "contapp_platform",
    "contapp_app",
    "contapp_enumerador",
  ];

  it.each(ROLES.flatMap((rol) => TABLAS.map((t) => [rol, t] as const)))(
    "%s no tiene ningun privilegio sobre %s",
    async (rol, t) => {
      for (const p of PRIVS_TABLA) {
        expect(
          (
            await consulta("select has_table_privilege($1, $2, $3) as v", [
              rol,
              t,
              p,
            ])
          )[0].v,
          `${rol} ${p}`,
        ).toBe(false);
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        expect(
          (
            await consulta("select has_any_column_privilege($1, $2, $3) as v", [
              rol,
              t,
              p,
            ])
          )[0].v,
          `${rol} ${p} (columna)`,
        ).toBe(false);
      }
    },
  );
});

// =================================================================================================
describe("privilegios de contapp_auth (las funciones SECURITY DEFINER escriben solo plan y suscripcion; D5)", () => {
  const tabla = async (t: string, p: string) =>
    (
      await consulta(
        "select has_table_privilege('contapp_auth', $1, $2) as v",
        [t, p],
      )
    )[0].v as boolean;

  it("plan y suscripcion: SELECT, INSERT y UPDATE; nunca DELETE ni TRUNCATE", async () => {
    for (const t of ["public.plan", "public.suscripcion"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE"])
        expect(await tabla(t, p), `${t} ${p}`).toBe(true);
      for (const p of ["DELETE", "TRUNCATE"])
        expect(await tabla(t, p), `${t} ${p}`).toBe(false);
    }
  });

  it("admin_plataforma: solo SELECT (el alta es por seed o CLI, nunca por una funcion)", async () => {
    expect(await tabla("public.admin_plataforma", "SELECT")).toBe(true);
    for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
      expect(await tabla("public.admin_plataforma", p), p).toBe(false);
    for (const p of ["INSERT", "UPDATE"]) {
      const v = (
        await consulta(
          "select has_any_column_privilege('contapp_auth', 'public.admin_plataforma', $1) as v",
          [p],
        )
      )[0].v;
      expect(v, `columna ${p}`).toBe(false);
    }
  });

  it("auth.registro_pendiente: SELECT, INSERT, UPDATE y DELETE (purga de vencidos); TRUNCATE no", async () => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
      expect(await tabla("auth.registro_pendiente", p), p).toBe(true);
    expect(await tabla("auth.registro_pendiente", "TRUNCATE")).toBe(false);
  });

  it("tenant: INSERT solo por columna (nombre, ruc_estudio); sin INSERT de tabla, UPDATE, DELETE ni TRUNCATE", async () => {
    expect(await tabla("public.tenant", "INSERT")).toBe(false);
    const col = async (c: string, p: string) =>
      (
        await consulta(
          "select has_column_privilege('contapp_auth', 'public.tenant', $1, $2) as v",
          [c, p],
        )
      )[0].v as boolean;
    expect(await col("nombre", "INSERT")).toBe(true);
    expect(await col("ruc_estudio", "INSERT")).toBe(true);
    expect(await col("id", "INSERT")).toBe(false);
    expect(await col("created_at", "INSERT")).toBe(false);
    expect(await col("updated_at", "INSERT")).toBe(false);
    for (const p of ["UPDATE", "DELETE", "TRUNCATE"])
      expect(await tabla("public.tenant", p), p).toBe(false);
    for (const c of ["nombre", "ruc_estudio", "id"])
      expect(await col(c, "UPDATE"), `UPDATE ${c}`).toBe(false);
  });

  it("registro_pendiente: dueño contapp_migrator y los unicos privilegios son los de contapp_auth", async () => {
    const dueno = await consulta(
      "select o.rolname as dueno from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass('auth.registro_pendiente')",
    );
    expect(dueno).toEqual([{ dueno: "contapp_migrator" }]);
    const quien = await consulta(
      `select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as quien
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass('auth.registro_pendiente') and a.grantee <> c.relowner`,
    );
    expect(quien.map((x) => x.quien)).toEqual(["contapp_auth"]);
  });
});

// =================================================================================================
describe("CHECK de plan (CA-1: valores inválidos se rechazan en la BD)", () => {
  const SQL = `insert into plan (codigo, nombre, precio_mensual, precio_anual, max_rucs, max_usuarios, precio_ruc_extra, max_rucs_extra,
                       frecuencia_buzon_min, features) values ($1, 'Plan de prueba', $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`;
  const base = {
    precio_mensual: "10.00",
    precio_anual: null as string | null,
    max_rucs: 10,
    max_usuarios: 5 as number | null,
    precio_ruc_extra: "1.00",
    max_rucs_extra: 2,
    frecuencia_buzon_min: 60,
    features: "{}",
  };
  const insertar = (c: Partial<typeof base> & { codigo?: string | null }) => {
    const f = { ...base, ...c };
    const cod =
      c.codigo === undefined
        ? `t1_chk_${randomBytes(4).toString("hex")}`
        : c.codigo;
    return intentarRaw(admin, null, SQL, [
      cod,
      f.precio_mensual,
      f.precio_anual,
      f.max_rucs,
      f.max_usuarios,
      f.precio_ruc_extra,
      f.max_rucs_extra,
      f.frecuencia_buzon_min,
      f.features,
    ]);
  };

  it("control: un plan valido se inserta (la prueba no es vacua)", async () => {
    expect(await insertar({})).toEqual({ ok: true, rowCount: 1 });
  });

  it("max_usuarios NULL (ilimitado) y precio_anual NULL son validos", async () => {
    expect(await insertar({ max_usuarios: null })).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(await insertar({ precio_anual: null })).toEqual({
      ok: true,
      rowCount: 1,
    });
  });

  it("el tope extra del 20 % se cumple en el borde: max_rucs 10 admite extra 2 y rechaza 3 (extra * 5 <= max_rucs)", async () => {
    expect(await insertar({ max_rucs: 10, max_rucs_extra: 2 })).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(codigo(await insertar({ max_rucs: 10, max_rucs_extra: 3 }))).toBe(
      "23514",
    );
    expect(codigo(await insertar({ max_rucs: 1, max_rucs_extra: 1 }))).toBe(
      "23514",
    );
    expect(await insertar({ max_rucs: 5, max_rucs_extra: 1 })).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(await insertar({ max_rucs: 3, max_rucs_extra: 0 })).toEqual({
      ok: true,
      rowCount: 1,
    });
  });

  it.each([
    ["precio_mensual negativo", { precio_mensual: "-0.01" }],
    ["precio_anual negativo", { precio_anual: "-1.00" }],
    ["precio_ruc_extra negativo", { precio_ruc_extra: "-1.00" }],
    ["max_rucs en 0", { max_rucs: 0, max_rucs_extra: 0 }],
    ["max_rucs negativo", { max_rucs: -5, max_rucs_extra: 0 }],
    ["max_usuarios en 0", { max_usuarios: 0 }],
    ["max_usuarios negativo", { max_usuarios: -1 }],
    ["max_rucs_extra negativo", { max_rucs_extra: -1 }],
    ["frecuencia_buzon_min en 0", { frecuencia_buzon_min: 0 }],
    ["frecuencia_buzon_min negativa", { frecuencia_buzon_min: -60 }],
    ["features que es un arreglo", { features: "[]" }],
    ["features que es una cadena", { features: '"x"' }],
    ["features que es un numero", { features: "1" }],
    ["features que es null JSON", { features: "null" }],
  ])("rechaza %s con 23514", async (_n, cambios) => {
    expect(codigo(await insertar(cambios))).toBe("23514");
  });

  it.each([
    ["max_rucs", { max_rucs: null as unknown as number }],
    ["precio_mensual", { precio_mensual: null as unknown as string }],
    [
      "frecuencia_buzon_min",
      { frecuencia_buzon_min: null as unknown as number },
    ],
    ["codigo", { codigo: null }],
  ])("%s es obligatorio (23502)", async (_n, cambios) => {
    expect(codigo(await insertar(cambios))).toBe("23502");
  });

  it("el codigo es UNIQUE: repetir uno del seed da 23505", async () => {
    expect(codigo(await insertar({ codigo: "prueba" }))).toBe("23505");
  });
});

// =================================================================================================
describe("CHECK, UNIQUE y FK de suscripcion (D1, CA-1)", () => {
  const INS = `insert into suscripcion (tenant_id, plan_id, estado, prueba_vence_en, rucs_extra_contratados)
               values ($1, $2, $3, case when $4::interval is null then null else now() + $4::interval end, $5)`;

  it("control: una suscripcion 'prueba' con vencimiento y una 'activa' sin vencimiento se insertan", async () => {
    const plan = await ep.planSeed("prueba");
    const x = await ep.ea.estudio();
    expect(
      await intentarRaw(admin, null, INS, [x.id, plan, "prueba", "14 days", 0]),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(
      await intentarRaw(admin, null, INS, [x.id, plan, "activa", null, 0]),
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("estado 'prueba' exige prueba_vence_en (23514)", async () => {
    const x = await ep.ea.estudio();
    const r = await intentarRaw(admin, null, INS, [
      x.id,
      await ep.planSeed("prueba"),
      "prueba",
      null,
      0,
    ]);
    expect(codigo(r)).toBe("23514");
  });

  it.each([
    ["estado fuera de la lista", "vencida", 0],
    ["estado vacio", "", 0],
    ["rucs_extra_contratados negativo", "activa", -1],
  ])("rechaza %s con 23514", async (_n, estado, extra) => {
    const x = await ep.ea.estudio();
    const r = await intentarRaw(admin, null, INS, [
      x.id,
      await ep.planSeed("prueba"),
      estado,
      null,
      extra,
    ]);
    expect(codigo(r)).toBe("23514");
  });

  it("UNIQUE(tenant_id): un estudio no puede tener dos suscripciones (23505)", async () => {
    const plan = await ep.plan();
    const x = await ep.estudioConPlan(plan.id);
    const r = await intentarRaw(admin, null, INS, [
      x.id,
      plan.id,
      "activa",
      null,
      0,
    ]);
    expect(codigo(r)).toBe("23505");
  });

  it("FK: plan o estudio inexistente (23503)", async () => {
    const x = await ep.ea.estudio();
    const inexistente = "01920000-0000-7000-8000-00000000dead";
    expect(
      codigo(
        await intentarRaw(admin, null, INS, [
          x.id,
          inexistente,
          "activa",
          null,
          0,
        ]),
      ),
    ).toBe("23503");
    expect(
      codigo(
        await intentarRaw(admin, null, INS, [
          inexistente,
          await ep.planSeed("prueba"),
          "activa",
          null,
          0,
        ]),
      ),
    ).toBe("23503");
  });

  it("no se puede borrar un plan que tiene suscripciones (FK sin cascada: desactivar no borra, CA-1)", async () => {
    const plan = await ep.plan();
    await ep.estudioConPlan(plan.id);
    expect(
      codigo(
        await intentarRaw(admin, null, "delete from plan where id = $1", [
          plan.id,
        ]),
      ),
    ).toBe("23503");
  });
});

// =================================================================================================
describe("CHECK de tenant.ruc_estudio (11 digitos, sin unicidad; D2) y admin_plataforma", () => {
  const INS =
    "insert into tenant (nombre, ruc_estudio) values ('Estudio T1 chk', $1)";

  it.each([
    ["NULL", null],
    ["11 digitos", "20100070970"],
  ])("acepta ruc_estudio %s", async (_n, ruc) => {
    expect(await intentarRaw(admin, null, INS, [ruc])).toEqual({
      ok: true,
      rowCount: 1,
    });
  });

  it.each([
    ["10 digitos", "2010007097"],
    ["12 digitos", "201000709700"],
    ["con letras", "2010007097a"],
    ["con espacios", " 20100070970"],
    ["vacio", ""],
  ])("rechaza ruc_estudio %s con 23514", async (_n, ruc) => {
    expect(codigo(await intentarRaw(admin, null, INS, [ruc]))).toBe("23514");
  });

  it("no hay unicidad: dos estudios pueden declarar el mismo RUC (informativo)", async () => {
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(INS, ["20100070970"]);
      await c.query(INS, ["20100070970"]);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("admin_plataforma: PK en usuario_id (23505) y FK a usuario (23503)", async () => {
    const u = await ep.ea.cuenta();
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("insert into admin_plataforma (usuario_id) values ($1)", [
        u.id,
      ]);
      await c.query("SAVEPOINT s1");
      const dup = await c
        .query("insert into admin_plataforma (usuario_id) values ($1)", [u.id])
        .catch((e) => e);
      expect((dup as { code?: string }).code).toBe("23505");
      await c.query("ROLLBACK TO SAVEPOINT s1");
      const fk = await c
        .query(
          "insert into admin_plataforma (usuario_id) values ('01920000-0000-7000-8000-00000000dead')",
        )
        .catch((e) => e);
      expect((fk as { code?: string }).code).toBe("23503");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});

// =================================================================================================
describe("CHECK de auth.registro_pendiente (D3) y de auth.limite_tasa (registro_ip, registro_correo)", () => {
  const SQL = `insert into auth.registro_pendiente (correo, nombre_estudio, ruc_estudio, nombre_usuario, token_hash)
               values ($1, $2, $3, $4, $5)`;
  const bytes = (n: number) => randomBytes(n);
  const ok = {
    correo: "registro-chk@auth.test",
    estudio: "Estudio Valido",
    ruc: "20100070970" as string | null,
    nombre: "Dueña Prueba",
    hash: () => bytes(32),
  };
  const insertar = (
    c: Partial<{
      correo: string;
      estudio: string;
      ruc: string | null;
      nombre: string;
      hash: Buffer;
    }>,
  ) =>
    intentarRaw(admin, null, SQL, [
      c.correo ?? ok.correo,
      c.estudio ?? ok.estudio,
      c.ruc === undefined ? ok.ruc : c.ruc,
      c.nombre ?? ok.nombre,
      c.hash ?? ok.hash(),
    ]);

  it("control: un pendiente valido (con y sin RUC) se inserta", async () => {
    expect(await insertar({})).toEqual({ ok: true, rowCount: 1 });
    expect(await insertar({ ruc: null })).toEqual({ ok: true, rowCount: 1 });
  });

  it.each([
    ["correo con mayusculas", { correo: "Mayus@auth.test" }],
    ["correo con espacio", { correo: " espacio@auth.test" }],
    ["nombre_estudio de 1 caracter", { estudio: "A" }],
    ["nombre_estudio vacio", { estudio: "" }],
    ["nombre_estudio de 201 caracteres", { estudio: "x".repeat(201) }],
    ["nombre_estudio con salto de linea", { estudio: "Estudio\nMalo" }],
    ["ruc_estudio de 10 digitos", { ruc: "2010007097" }],
    ["ruc_estudio con letras", { ruc: "2010007097x" }],
    ["nombre_usuario vacio", { nombre: "" }],
    ["nombre_usuario de 201 caracteres", { nombre: "x".repeat(201) }],
    ["nombre_usuario con caracter de control", { nombre: "Dueño\u0007" }],
    ["nombre_usuario con caracter invisible (U+200B)", { nombre: "Due​ño" }],
    ["nombre_usuario sin letras ni digitos", { nombre: "!!!" }],
    ["token_hash de 31 B", { hash: bytes(31) }],
    ["token_hash de 33 B", { hash: bytes(33) }],
  ])("rechaza %s con 23514", async (_n, cambios) => {
    expect(codigo(await insertar(cambios))).toBe("23514");
  });

  it("token_hash es UNIQUE (23505)", async () => {
    const h = bytes(32);
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(SQL, [ok.correo, ok.estudio, null, ok.nombre, h]);
      await c.query("SAVEPOINT s1");
      const dup = await c
        .query(SQL, ["otro-chk@auth.test", ok.estudio, null, ok.nombre, h])
        .catch((e) => e);
      expect((dup as { code?: string }).code).toBe("23505");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("vence_en por defecto = creada_en + 24 h y consumida_en nace NULL", async () => {
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(
        `${SQL} returning extract(epoch from (vence_en - creada_en))::int as segundos, consumida_en, creada_en`,
        [ok.correo, ok.estudio, null, ok.nombre, bytes(32)],
      );
      expect(r.rows[0].segundos).toBe(24 * 3600);
      expect(r.rows[0].consumida_en).toBeNull();
      expect(r.rows[0].creada_en).toBeInstanceOf(Date);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  // Ajuste de 006 (T13a, D15): 0025 amplia limite_tasa_tipo_valido con `registro_confirmar_ip`.
  it.each(["registro_ip", "registro_correo", "registro_confirmar_ip"])(
    "auth.limite_tasa admite el tipo %s (23514 solo para tipos desconocidos)",
    async (tipo) => {
      const sql =
        "insert into auth.limite_tasa (tipo, sujeto, ventana_inicio, conteo) values ($1, 'sujeto-prueba', now(), 1)";
      expect(await intentarRaw(admin, null, sql, [tipo])).toEqual({
        ok: true,
        rowCount: 1,
      });
      expect(
        codigo(await intentarRaw(admin, null, sql, ["registro_otro"])),
      ).toBe("23514");
    },
  );
});

// =================================================================================================
describe("seed de planes (D1, 01 §3) y backfill de estudios existentes (D2)", () => {
  it("los 5 planes de 01 §3 existen con sus precios, limites y frecuencia de buzon (activos)", async () => {
    const r = await consulta(
      `select codigo, precio_mensual, precio_anual, max_rucs, max_usuarios, precio_ruc_extra, max_rucs_extra, frecuencia_buzon_min, activo
         from plan where codigo = any($1::text[]) order by codigo`,
      [PLANES_SEED.map((p) => p.codigo)],
    );
    const porCodigo = (a: { codigo: string }, b: { codigo: string }) =>
      a.codigo < b.codigo ? -1 : a.codigo > b.codigo ? 1 : 0;
    expect([...r].sort(porCodigo)).toEqual(
      [...PLANES_SEED].sort(porCodigo).map((p) => ({ ...p, activo: true })),
    );
  });

  it("cada plan sembrado respeta el tope del 20 %: max_rucs_extra * 5 <= max_rucs", async () => {
    const r = await consulta(
      "select codigo from plan where codigo = any($1::text[]) and max_rucs_extra * 5 > max_rucs",
      [PLANES_SEED.map((p) => p.codigo)],
    );
    expect(r).toEqual([]);
  });

  it("Corporativo: 600 RUCs y max_usuarios NULL (sin limite de usuarios, D1)", async () => {
    const r = await consulta(
      "select max_rucs, max_usuarios from plan where codigo = 'corporativo'",
    );
    expect(r).toEqual([{ max_rucs: 600, max_usuarios: null }]);
  });

  it("los estudios del seed (A y B) tienen suscripcion corporativo/activa, sin RUCs adicionales", async () => {
    const r = await consulta(
      `select s.tenant_id, p.codigo, s.estado, s.rucs_extra_contratados from suscripcion s join plan p on p.id = s.plan_id
        where s.tenant_id = any($1::uuid[]) order by s.tenant_id`,
      [[A(), B()]],
    );
    expect(r).toEqual(
      [A(), B()]
        .sort()
        .map((t) => ({
          tenant_id: t,
          codigo: "corporativo",
          estado: "activa",
          rucs_extra_contratados: 0,
        })),
    );
  });

  it("todo estudio existente tiene suscripcion (los de fixtures 'Estudio T1/T2 ...' en curso se excluyen)", async () => {
    const r = await consulta(
      `select t.id from tenant t where not exists (select 1 from suscripcion s where s.tenant_id = t.id)
          and t.nombre not like 'Estudio T1 %' and t.nombre not like 'Estudio T2 %'`,
    );
    expect(r).toEqual([]);
  });
});
