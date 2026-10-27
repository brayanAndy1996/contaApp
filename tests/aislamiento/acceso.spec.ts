// Spec 005 (T2, rojo): catalogo, privilegios y restricciones de las tablas nuevas `asignacion` e `invitacion`,
// de `membresia` (desactivada_en y CHECK de rol), del trigger del ultimo Dueño y de las funciones de
// invitacion (CA-3, CA-7, CA-9, CA-10, CA-13; D6, D7, D9, D10, D19, D21).
// Contrato que fija (T7, migraciones 0011-0013):
// - asignacion(id, tenant_id, cliente_id, usuario_id, tipo, created_at, updated_at) e
//   invitacion(id, tenant_id, correo, rol, invitado_por, token_hash, creada_en, vence_en, aceptada_en, aceptada_por,
//   revocada_en), dueño contapp_migrator, RLS ENABLE+FORCE y tenant_isolation FOR ALL.
// - privilegios: contapp_backend asignacion S/I/U/D e invitacion S/I/U (sin DELETE); worker, platform y app, nada.
// - FK compuestas con tenant_id hacia cliente(tenant_id, id) y membresia(tenant_id, usuario_id).
// - membresia.desactivada_en timestamptz NULL y CHECK de rol (dueno|admin|contador|asistente|lectura).
// - trigger membresia_ultimo_dueno AFTER UPDATE OR DELETE FOR EACH ROW, SECURITY INVOKER, search_path fijo.
// - auth.invitacion_vigente(bytea), auth.invitacion_aceptar_nueva(bytea, text, text),
//   auth.invitacion_aceptar_existente(bytea, bytea): SECURITY DEFINER, dueño contapp_auth, EXECUTE solo contapp_backend
//   (los privilegios y el search_path de las 15 funciones los comprueba auth.spec.ts con FUNCIONES_AUTH).
// - seed: uA y uB son `dueno`; uAB (contador) es responsable del primer cliente de A y de B.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAcceso, sha256 } from "./acceso-soporte";
import { abrirAdmin } from "./auth-soporte";
import { abrirPool, intentarRaw, semilla } from "./soporte";

let admin: Pool; // superusuario: catalogo y escrituras con rollback
let pool: Pool; // contapp_app (DATABASE_URL): SET LOCAL ROLE de las pruebas de privilegios
let ea: EscenarioAcceso;
beforeAll(() => {
  admin = abrirAdmin(4);
  pool = abrirPool(3);
  ea = new EscenarioAcceso(admin);
});
afterAll(async () => {
  await ea?.limpiar();
  await pool?.end();
  await admin?.end();
});

const consulta = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
const NUEVAS = ["asignacion", "invitacion"] as const;
const PRIVS_TABLA = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

describe("tablas asignacion e invitacion: dueño, RLS y tenant_isolation (CA-13)", () => {
  it.each(NUEVAS)("%s: dueño contapp_migrator, RLS ENABLE + FORCE", async (t) => {
    const r = await consulta(
      `select o.rolname as dueno, c.relrowsecurity as rls, c.relforcerowsecurity as forzada
         from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass($1)`,
      [`public.${t}`],
    );
    expect(r).toEqual([{ dueno: "contapp_migrator", rls: true, forzada: true }]);
  });

  it.each(NUEVAS)("%s: tenant_id uuid NOT NULL y politica tenant_isolation FOR ALL con USING y WITH CHECK", async (t) => {
    const col = await consulta(
      `select a.attnotnull as no_nula, ty.typname as tipo from pg_attribute a join pg_type ty on ty.oid = a.atttypid
        where a.attrelid = to_regclass($1) and a.attname = 'tenant_id' and not a.attisdropped`,
      [`public.${t}`],
    );
    expect(col).toEqual([{ no_nula: true, tipo: "uuid" }]);
    const p = await consulta(
      `select cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = $1 and policyname = 'tenant_isolation'`,
      [t],
    );
    expect(p).toHaveLength(1);
    expect(p[0].cmd).toBe("ALL");
    expect(p[0].qual).toContain("app.tenant_id");
    expect(p[0].with_check).toContain("app.tenant_id");
  });

  it("invitacion guarda solo el hash del token: ninguna columna de token en claro (CA-3, CA-14)", async () => {
    const r = await consulta(
      `select a.attname from pg_attribute a where a.attrelid = to_regclass('public.invitacion') and a.attnum > 0 and not a.attisdropped order by 1`,
    );
    expect(r.map((x) => x.attname)).toEqual(
      [
        "aceptada_en",
        "aceptada_por",
        "correo",
        "creada_en",
        "id",
        "invitado_por",
        "revocada_en",
        "rol",
        "tenant_id",
        "token_hash",
        "vence_en",
      ].sort(),
    );
  });

  it("asignacion tiene exactamente las columnas del plan (D6)", async () => {
    const r = await consulta(
      `select a.attname from pg_attribute a where a.attrelid = to_regclass('public.asignacion') and a.attnum > 0 and not a.attisdropped order by 1`,
    );
    expect(r.map((x) => x.attname)).toEqual(
      ["cliente_id", "created_at", "id", "tenant_id", "tipo", "updated_at", "usuario_id"].sort(),
    );
  });

  it("membresia gana desactivada_en timestamptz NULL (D9)", async () => {
    const r = await consulta(
      `select a.attnotnull as no_nula, ty.typname as tipo from pg_attribute a join pg_type ty on ty.oid = a.atttypid
        where a.attrelid = to_regclass('public.membresia') and a.attname = 'desactivada_en' and not a.attisdropped`,
    );
    expect(r).toEqual([{ no_nula: false, tipo: "timestamptz" }]);
  });
});

describe("privilegios exactos por rol (CA-13)", () => {
  // Privilegio de tabla o de alguna columna (el plan admite concederlo por columna, como en 0006).
  const tiene = async (rol: string, t: string, p: string) =>
    (
      await consulta(
        `select has_table_privilege($1, to_regclass($2), $3)
                ${["SELECT", "INSERT", "UPDATE", "REFERENCES"].includes(p) ? "or has_any_column_privilege($1, to_regclass($2), $3)" : ""} as v`,
        [rol, `public.${t}`, p],
      )
    )[0].v as boolean;

  const concedidos = async (t: string, rol: string): Promise<string[]> => {
    const out: string[] = [];
    for (const p of PRIVS_TABLA) if (await tiene(rol, t, p)) out.push(p);
    return out;
  };

  it("contapp_backend: asignacion SELECT, INSERT, UPDATE, DELETE y nada mas", async () => {
    expect(await concedidos("asignacion", "contapp_backend")).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
  });

  it("contapp_backend: invitacion SELECT, INSERT, UPDATE y SIN DELETE", async () => {
    expect(await concedidos("invitacion", "contapp_backend")).toEqual(["SELECT", "INSERT", "UPDATE"]);
  });

  // Ajuste de 008 (T3, CA-14, D17): el despachador (contapp_worker, dentro de withTenant) revalida el alcance de quien
  // encolo leyendo `asignacion`; por eso 0018 le concede SELECT (solo lectura, bajo la RLS tenant_isolation) y nada mas.
  // HUECO DEL PLAN 008 (informado en T3): el plan no lista esta concesion; sin ella revalidarEncolado no puede
  // comprobar el alcance `asignado`. `invitacion` sigue sin ningun privilegio para el worker.
  it("contapp_worker: asignacion SOLO SELECT (008, D17) y nada sobre invitacion", async () => {
    expect(await concedidos("asignacion", "contapp_worker")).toEqual(["SELECT"]);
    for (const p of ["INSERT", "UPDATE", "REFERENCES"]) {
      const r = await consulta("select has_any_column_privilege('contapp_worker', to_regclass('public.asignacion'), $1) as v", [p]);
      expect(r[0].v, `worker ${p} (columna) en asignacion`).toBe(false);
    }
    expect(await concedidos("invitacion", "contapp_worker")).toEqual([]);
  });

  it.each([
    ...["contapp_platform", "contapp_app"].flatMap((rol) => NUEVAS.map((t) => [rol, t] as const)),
    ["contapp_worker", "invitacion"] as const,
  ])("%s no tiene ningun privilegio sobre %s (ni de tabla ni de columna)", async (rol, t) => {
    expect(await concedidos(t, rol)).toEqual([]);
    for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
      const r = await consulta("select has_any_column_privilege($1, to_regclass($2), $3) as v", [rol, `public.${t}`, p]);
      expect(r[0].v, `${rol} ${p} (columna)`).toBe(false);
    }
  });

  it.each(NUEVAS)("%s: ni PUBLIC ni otro rol (salvo backend y contapp_auth) aparece en la ACL", async (t) => {
    const r = await consulta(
      `select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as quien
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass($1) and a.grantee <> c.relowner
       union
       select distinct case when a2.grantee = 0 then 'PUBLIC' else a2.grantee::regrole::text end
         from pg_attribute at cross join lateral aclexplode(at.attacl) a2
         join pg_class c2 on c2.oid = at.attrelid
        where at.attrelid = to_regclass($1) and at.attnum > 0 and a2.grantee <> c2.relowner
        order by 1`,
      [`public.${t}`],
    );
    // Ajuste de 008 (T3): asignacion tambien lista a contapp_worker (SELECT, D17).
    const esperado = t === "invitacion" ? ["contapp_auth", "contapp_backend"] : ["contapp_backend", "contapp_worker"];
    expect(r.map((x) => x.quien)).toEqual(esperado);
  });

  it("contapp_auth: invitacion SELECT y UPDATE (sin INSERT, DELETE ni TRUNCATE) y nada sobre asignacion", async () => {
    expect(await concedidos("invitacion", "contapp_auth")).toEqual(["SELECT", "UPDATE"]);
    expect(await concedidos("asignacion", "contapp_auth")).toEqual([]);
  });

  it("contapp_auth: usuario y membresia SELECT e INSERT, sin UPDATE, DELETE ni TRUNCATE (aceptar_nueva)", async () => {
    for (const t of ["usuario", "membresia"]) {
      expect(await concedidos(t, "contapp_auth"), t).toEqual(["SELECT", "INSERT"]);
    }
  });

  it("contapp_backend sigue sin escribir auth.* por SQL (solo por las funciones)", async () => {
    for (const t of ["usuario_contrasena", "sesion"]) {
      const r = await intentarRaw(pool, "contapp_backend", `insert into auth.${t} default values`);
      expect(r.ok ? "ok" : r.code, t).toBe("42501");
    }
  });
});

describe("FK compuestas con tenant_id (CA-13, D6)", () => {
  const fks = async (t: string) =>
    consulta(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c where c.conrelid = to_regclass($1) and c.contype = 'f' order by 1`,
      [`public.${t}`],
    );

  it("asignacion: (tenant_id, cliente_id) -> cliente(tenant_id, id) y (tenant_id, usuario_id) -> membresia(tenant_id, usuario_id)", async () => {
    const defs = (await fks("asignacion")).map((x) => String(x.def).replace(/\s+/g, " "));
    expect(defs.some((d) => /FOREIGN KEY \(tenant_id, cliente_id\) REFERENCES (public\.)?cliente\(tenant_id, id\)/.test(d))).toBe(true);
    expect(
      defs.some((d) => /FOREIGN KEY \(tenant_id, usuario_id\) REFERENCES (public\.)?membresia\(tenant_id, usuario_id\)/.test(d)),
    ).toBe(true);
  });

  it("invitacion: (tenant_id, invitado_por) -> membresia(tenant_id, usuario_id) y aceptada_por -> usuario(id)", async () => {
    const defs = (await fks("invitacion")).map((x) => String(x.def).replace(/\s+/g, " "));
    expect(
      defs.some((d) => /FOREIGN KEY \(tenant_id, invitado_por\) REFERENCES (public\.)?membresia\(tenant_id, usuario_id\)/.test(d)),
    ).toBe(true);
    expect(defs.some((d) => /FOREIGN KEY \(aceptada_por\) REFERENCES (public\.)?usuario\(id\)/.test(d))).toBe(true);
  });

  it("un cliente de otro estudio no se puede asignar (23503); el control del mismo estudio si", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const u = await ea.miembro(x.id, "contador");
    const propio = await ea.cliente(x.id);
    const ajeno = await ea.cliente(y.id);
    const sql = "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'colaborador')";
    expect(await intentarRaw(admin, null, sql, [x.id, propio, u.id])).toEqual({ ok: true, rowCount: 1 });
    const r = await intentarRaw(admin, null, sql, [x.id, ajeno, u.id]);
    expect(r.ok ? "ok" : r.code).toBe("23503");
  });

  it("una membresia de otro estudio no se puede asignar (23503)", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const deY = await ea.miembro(y.id, "contador");
    const cliente = await ea.cliente(x.id);
    const r = await intentarRaw(
      admin,
      null,
      "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'colaborador')",
      [x.id, cliente, deY.id],
    );
    expect(r.ok ? "ok" : r.code).toBe("23503");
  });

  it("una invitacion no puede venir de quien no es miembro del estudio (23503)", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const deY = await ea.miembro(y.id, "dueno");
    const r = await intentarRaw(
      admin,
      null,
      "insert into invitacion (tenant_id, correo, rol, invitado_por, token_hash, creada_en, vence_en) values ($1, 'f1@auth.test', 'lectura', $2, $3, now(), now() + interval '72 hours')",
      [x.id, deY.id, sha256(Buffer.from("fk"))],
    );
    expect(r.ok ? "ok" : r.code).toBe("23503");
  });
});

describe("CHECK y unicidad (CA-3, CA-7, D6, D7, D21)", () => {
  it("membresia.rol: acepta los 5 roles y rechaza otro con 23514 (D21)", async () => {
    const x = await ea.estudio();
    for (const rol of ["dueno", "admin", "contador", "asistente", "lectura"]) {
      const u = await ea.cuenta();
      const r = await intentarRaw(admin, null, "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3)", [
        x.id,
        u.id,
        rol,
      ]);
      expect(r, rol).toEqual({ ok: true, rowCount: 1 });
    }
    for (const malo of ["superadmin", "Dueno", "owner", ""]) {
      const u = await ea.cuenta();
      const r = await intentarRaw(admin, null, "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3)", [
        x.id,
        u.id,
        malo,
      ]);
      expect(r.ok ? "ok" : r.code, `rol "${malo}"`).toBe("23514");
    }
  });

  it("asignacion.tipo: solo responsable o colaborador (23514)", async () => {
    const x = await ea.estudio();
    const u = await ea.miembro(x.id, "contador");
    const c = await ea.cliente(x.id);
    const sql = "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, $4)";
    for (const ok of ["responsable", "colaborador"]) {
      expect(await intentarRaw(admin, null, sql, [x.id, c, u.id, ok]), ok).toEqual({ ok: true, rowCount: 1 });
    }
    for (const malo of ["dueno", "Responsable", ""]) {
      const r = await intentarRaw(admin, null, sql, [x.id, c, u.id, malo]);
      expect(r.ok ? "ok" : r.code, malo).toBe("23514");
    }
  });

  it("asignacion: un usuario aparece una sola vez por cliente (23505)", async () => {
    const x = await ea.estudio();
    const u = await ea.miembro(x.id, "contador");
    const c = await ea.cliente(x.id);
    await ea.asignar(x.id, c, u.id, "colaborador");
    const r = await intentarRaw(
      admin,
      null,
      "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'colaborador')",
      [x.id, c, u.id],
    );
    expect(r.ok ? "ok" : r.code).toBe("23505");
  });

  it("indice unico parcial: un solo responsable por cliente (23505) y los colaboradores no cuentan (CA-7)", async () => {
    const x = await ea.estudio();
    const u1 = await ea.miembro(x.id, "contador");
    const u2 = await ea.miembro(x.id, "contador");
    const u3 = await ea.miembro(x.id, "asistente");
    const c = await ea.cliente(x.id);
    const ins = "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, $4)";
    await ea.asignar(x.id, c, u1.id, "responsable");
    const segundo = await intentarRaw(admin, null, ins, [x.id, c, u2.id, "responsable"]);
    expect(segundo.ok ? "ok" : segundo.code).toBe("23505");
    expect(await intentarRaw(admin, null, ins, [x.id, c, u2.id, "colaborador"])).toEqual({ ok: true, rowCount: 1 });
    expect(await intentarRaw(admin, null, ins, [x.id, c, u3.id, "colaborador"])).toEqual({ ok: true, rowCount: 1 });
    const idx = await consulta(
      `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'asignacion' and indexdef ilike '%unique%' and indexdef ilike '%responsable%'`,
    );
    expect(idx.length).toBeGreaterThanOrEqual(1);
  });

  it("DOS CONEXIONES asignando responsable al mismo cliente a la vez dejan exactamente uno (CA-7)", async () => {
    const x = await ea.estudio();
    const c = await ea.cliente(x.id);
    const usuarios = await Promise.all([1, 2, 3, 4].map(() => ea.miembro(x.id, "contador")));
    const resultados = await Promise.allSettled(
      usuarios.map(async (u) => {
        const cx = await admin.connect();
        try {
          await cx.query("BEGIN");
          await cx.query(
            "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'responsable')",
            [x.id, c, u.id],
          );
          await cx.query("select pg_sleep(0.2)");
          await cx.query("COMMIT");
        } catch (e) {
          await cx.query("ROLLBACK").catch(() => undefined);
          throw e;
        } finally {
          cx.release();
        }
      }),
    );
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of resultados.filter((q): q is PromiseRejectedResult => q.status === "rejected")) {
      expect((r.reason as { code?: string }).code).toBe("23505");
    }
    const n = await consulta("select count(*)::int as n from asignacion where cliente_id = $1 and tipo = 'responsable'", [c]);
    expect(n[0].n).toBe(1);
  });

  const INV =
    "insert into invitacion (tenant_id, correo, rol, invitado_por, token_hash, creada_en, vence_en) values ($1, $2, $3, $4, $5, now(), now() + interval '72 hours')";

  it("invitacion.rol y correo: CHECK de rol y el mismo CHECK de correo que usuario.email (23514)", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const h = () => sha256(Buffer.from(Math.random().toString()));
    expect(await intentarRaw(admin, null, INV, [x.id, "ok1@auth.test", "lectura", d.id, h()])).toEqual({ ok: true, rowCount: 1 });
    const casos: [string, string, string][] = [
      ["rol desconocido", "ok2@auth.test", "superadmin"],
      ["correo con mayusculas", "Mayus@auth.test", "lectura"],
      ["correo con espacio al final", "espacio@auth.test ", "lectura"],
      ["correo no NFC", "café@auth.test", "lectura"],
    ];
    for (const [n, correo, rol] of casos) {
      const r = await intentarRaw(admin, null, INV, [x.id, correo, rol, d.id, h()]);
      expect(r.ok ? "ok" : r.code, n).toBe("23514");
    }
  });

  it("invitacion.token_hash: exactamente 32 B (23514) y UNIQUE (23505)", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    for (const n of [31, 33, 0]) {
      const r = await intentarRaw(admin, null, INV, [x.id, `n${n}@auth.test`, "lectura", d.id, Buffer.alloc(n, 5)]);
      expect(r.ok ? "ok" : r.code, `${n} B`).toBe("23514");
    }
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(INV, [x.id, "u1@auth.test", "lectura", d.id, Buffer.alloc(32, 8)]);
      await c.query("SAVEPOINT s");
      const dup = await c.query(INV, [x.id, "u2@auth.test", "lectura", d.id, Buffer.alloc(32, 8)]).catch((e) => e);
      expect((dup as { code?: string }).code).toBe("23505");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("indice unico parcial (tenant_id, correo): una invitacion pendiente por correo; la revocada o aceptada libera el correo", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const dx = await ea.miembro(x.id, "dueno");
    const dy = await ea.miembro(y.id, "dueno");
    const correo = ea.esc.correoNuevo();
    const h = () => sha256(Buffer.from(Math.random().toString()));
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(INV, [x.id, correo, "lectura", dx.id, h()]);
      await c.query("SAVEPOINT s1");
      const dup = await c.query(INV, [x.id, correo, "admin", dx.id, h()]).catch((e) => e);
      expect((dup as { code?: string }).code).toBe("23505");
      await c.query("ROLLBACK TO SAVEPOINT s1");
      // el mismo correo en OTRO estudio no choca
      await c.query(INV, [y.id, correo, "lectura", dy.id, h()]);
      // revocada: libera el correo en x
      await c.query("update invitacion set revocada_en = now() where tenant_id = $1 and correo = $2", [x.id, correo]);
      await c.query(INV, [x.id, correo, "admin", dx.id, h()]);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});

describe("conversion del seed a Dueño (D1, 0011)", () => {
  it("uA y uB son `dueno` en su estudio; uAB sigue siendo `contador` en ambos", async () => {
    const s = semilla();
    const rol = async (t: string, u: string) =>
      (await consulta("select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [t, u]))[0];
    expect(await rol(s.tenantA, s.uA)).toEqual({ rol: "dueno", desactivada_en: null });
    expect(await rol(s.tenantB, s.uB)).toEqual({ rol: "dueno", desactivada_en: null });
    expect((await rol(s.tenantA, s.uAB)).rol).toBe("contador");
    expect((await rol(s.tenantB, s.uAB)).rol).toBe("contador");
  });

  it("todo estudio del seed tiene al menos un Dueño activo y ninguna membresia con rol fuera del catalogo", async () => {
    const s = semilla();
    const r = await consulta(
      `select tenant_id, count(*) filter (where rol = 'dueno' and desactivada_en is null)::int as duenos
         from membresia where tenant_id = any($1::uuid[]) group by 1`,
      [[s.tenantA, s.tenantB]],
    );
    expect(r).toHaveLength(2);
    for (const f of r) expect(f.duenos, f.tenant_id).toBeGreaterThanOrEqual(1);
    const fuera = await consulta(
      "select count(*)::int as n from membresia where rol not in ('dueno','admin','contador','asistente','lectura')",
    );
    expect(fuera[0].n).toBe(0);
  });

  it("el seed asigna a uAB (contador) como responsable del primer cliente de A y de B", async () => {
    const s = semilla();
    const r = await consulta(
      "select tenant_id, cliente_id, tipo from asignacion where usuario_id = $1 order by tenant_id",
      [s.uAB],
    );
    expect(r).toEqual(
      [
        { tenant_id: s.tenantA, cliente_id: s.clientesA[0]!.id, tipo: "responsable" },
        { tenant_id: s.tenantB, cliente_id: s.clientesB[0]!.id, tipo: "responsable" },
      ].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)),
    );
  });
});

describe("trigger membresia_ultimo_dueno: catalogo (D10, RF-028)", () => {
  it("existe como AFTER UPDATE OR DELETE FOR EACH ROW sobre membresia", async () => {
    const r = await consulta(
      `select t.tgname, t.tgtype, t.tgenabled, p.prosecdef, p.proconfig
         from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = to_regclass('public.membresia') and not t.tgisinternal and t.tgname = 'membresia_ultimo_dueno'`,
    );
    expect(r).toHaveLength(1);
    const tipo = Number(r[0].tgtype);
    expect(tipo & 1, "FOR EACH ROW").toBe(1);
    expect(tipo & 2, "AFTER (no BEFORE)").toBe(0);
    expect(tipo & 4, "sin INSERT").toBe(0);
    expect(tipo & 8, "DELETE").toBe(8);
    expect(tipo & 16, "UPDATE").toBe(16);
    expect(r[0].tgenabled).toBe("O");
  });

  it("su funcion es SECURITY INVOKER con search_path fijo", async () => {
    const r = await consulta(
      `select p.prosecdef, p.proconfig from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = to_regclass('public.membresia') and t.tgname = 'membresia_ultimo_dueno'`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].prosecdef).toBe(false);
    const sp = (r[0].proconfig as string[] | null)?.find((x) => x.startsWith("search_path="));
    expect(sp, "search_path fijo").toBeDefined();
  });

  it("es el unico trigger de usuario de membresia", async () => {
    const r = await consulta(
      "select t.tgname from pg_trigger t where t.tgrelid = to_regclass('public.membresia') and not t.tgisinternal order by 1",
    );
    expect(r.map((x) => x.tgname)).toEqual(["membresia_ultimo_dueno"]);
  });
});

describe("funciones de invitacion: firmas y propiedades (D7)", () => {
  it.each([
    ["invitacion_vigente", "auth.invitacion_vigente(bytea)"],
    ["invitacion_aceptar_nueva", "auth.invitacion_aceptar_nueva(bytea,text,text)"],
    ["invitacion_aceptar_existente", "auth.invitacion_aceptar_existente(bytea,bytea)"],
  ])("%s existe con la firma %s, SECURITY DEFINER, dueño contapp_auth y EXECUTE solo para contapp_backend", async (nombre, firma) => {
    const r = await consulta(
      `select p.oid::regprocedure::text as firma, p.prosecdef, o.rolname as dueno,
              has_function_privilege('contapp_backend', p.oid, 'EXECUTE') as backend,
              has_function_privilege('contapp_worker', p.oid, 'EXECUTE') as worker,
              has_function_privilege('contapp_platform', p.oid, 'EXECUTE') as platform,
              has_function_privilege('contapp_app', p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as publico,
              p.proconfig
         from pg_proc p join pg_roles o on o.oid = p.proowner
        where p.pronamespace = to_regnamespace('auth') and p.proname = $1`,
      [nombre],
    );
    expect(r).toHaveLength(1);
    expect(r[0].firma).toBe(firma);
    expect(r[0].prosecdef).toBe(true);
    expect(r[0].dueno).toBe("contapp_auth");
    expect([r[0].backend, r[0].worker, r[0].platform, r[0].app, r[0].publico]).toEqual([true, false, false, false, false]);
    const sp = (r[0].proconfig as string[] | null)?.find((x) => x.startsWith("search_path="));
    expect(sp).toMatch(/^search_path=pg_catalog,\s*pg_temp$/);
  });

  it("contapp_worker y contapp_platform no pueden llamar a las funciones de invitacion (42501)", async () => {
    // precondicion: la funcion existe (sin ella el 42501 saldria igual por el esquema y la prueba seria vacua)
    const existe = await consulta("select 1 from pg_proc where pronamespace = to_regnamespace('auth') and proname = 'invitacion_vigente'");
    expect(existe).toHaveLength(1);
    for (const rol of ["contapp_worker", "contapp_platform"]) {
      const r = await intentarRaw(admin, rol, "select * from auth.invitacion_vigente(decode(repeat('00', 32), 'hex'))");
      expect(r.ok ? "ok" : r.code, rol).toBe("42501");
    }
  });
});
