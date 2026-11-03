// Spec 007a (T1, rojo): esquema de `cliente` tras la migracion 0026 (D1; CA-2, CA-4, CA-5). Catalogo, CHECK, defaults, indice
// parcial, UNIQUE con archivados y RLS/grants intactos. El comportamiento (conteo de activos, revalidacion y carreras) esta en
// `clientes-funciones.spec.ts`. Falla hoy porque la migracion 0026 no existe; T5 la crea.
//
// Contrato de BD (plan.md, "BD"): `cliente` + estado_contribuyente text NULL y condicion_contribuyente text NULL (CHECK 1-50),
// regimen text NULL IN ('rg','rmt','rer','nrus'), zona text NOT NULL DEFAULT 'general' IN ('general','amazonia'),
// ventas_exoneradas/ventas_mixtas bool NOT NULL DEFAULT false, moneda_habitual text NOT NULL DEFAULT 'PEN' IN ('PEN','USD'),
// archivado_at timestamptz NULL; CHECK de largo de razon_social (1-200); indice parcial (tenant_id) WHERE archivado_at IS NULL.
// Los grants (tabla) y la politica tenant_isolation de 0002 no cambian. Todo corre con ROLLBACK: no deja datos.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAcceso } from "./acceso-soporte";
import { abrirAdmin } from "./auth-soporte";
import { clientesDe, crearDb, intentar, ROLES_APP, semilla, tenantDe, type ContappDb } from "./soporte";
import { enTx, probar } from "./trabajos-soporte";

let admin: Pool;
let ea: EscenarioAcceso;
beforeAll(() => {
  admin = abrirAdmin(4);
  ea = new EscenarioAcceso(admin);
});
afterAll(async () => {
  await ea?.limpiar();
  await admin?.end();
});

const COLUMNAS_NUEVAS = [
  "archivado_at",
  "condicion_contribuyente",
  "estado_contribuyente",
  "moneda_habitual",
  "regimen",
  "ventas_exoneradas",
  "ventas_mixtas",
  "zona",
] as const;

const RUC_PRUEBA = "29999999991";

/** Inserta un cliente en el estudio A del seed (superusuario, dentro de un ROLLBACK) con las columnas extra dadas. */
async function insertar(extra: Record<string, unknown> = {}, razonSocial = "Cliente de prueba") {
  const cols = ["tenant_id", "ruc", "razon_social", ...Object.keys(extra)];
  const vals = [tenantDe("A"), RUC_PRUEBA, razonSocial, ...Object.values(extra)];
  return enTx(admin, null, (c) =>
    probar(
      c,
      `insert into cliente (${cols.join(", ")}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
      vals,
    ),
  );
}

const SQLSTATE_CHECK = "23514";
const SQLSTATE_NOT_NULL = "23502";

describe("columnas de cliente (D1)", () => {
  it("las ocho columnas nuevas existen con tipo, nulabilidad y valor por defecto del plan", async () => {
    const r = await admin.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'cliente' and column_name = any($1::text[])
        order by column_name`,
      [COLUMNAS_NUEVAS],
    );
    const norm = (x: { column_name: string; data_type: string; is_nullable: string; column_default: string | null }) => ({
      columna: x.column_name,
      tipo: x.data_type,
      nulo: x.is_nullable === "YES",
      defecto: x.column_default === null ? null : x.column_default.replace(/::text$/, ""),
    });
    expect(r.rows.map(norm)).toEqual([
      { columna: "archivado_at", tipo: "timestamp with time zone", nulo: true, defecto: null },
      { columna: "condicion_contribuyente", tipo: "text", nulo: true, defecto: null },
      { columna: "estado_contribuyente", tipo: "text", nulo: true, defecto: null },
      { columna: "moneda_habitual", tipo: "text", nulo: false, defecto: "'PEN'" },
      { columna: "regimen", tipo: "text", nulo: true, defecto: null },
      { columna: "ventas_exoneradas", tipo: "boolean", nulo: false, defecto: "false" },
      { columna: "ventas_mixtas", tipo: "boolean", nulo: false, defecto: "false" },
      { columna: "zona", tipo: "text", nulo: false, defecto: "'general'" },
    ]);
  });

  it("un cliente insertado solo con ruc y razon social recibe los valores por defecto (perfil fiscal opcional, RF-036)", async () => {
    const r = await insertar();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const f = r.ok ? r.rows![0] : {};
    expect(f).toMatchObject({
      estado_contribuyente: null,
      condicion_contribuyente: null,
      regimen: null,
      zona: "general",
      ventas_exoneradas: false,
      ventas_mixtas: false,
      moneda_habitual: "PEN",
      archivado_at: null,
    });
  });

  it("un perfil fiscal completo y valido se guarda y se lee igual (CA-4)", async () => {
    const r = await insertar({
      estado_contribuyente: "ACTIVO",
      condicion_contribuyente: "HABIDO",
      regimen: "rmt",
      zona: "amazonia",
      ventas_exoneradas: true,
      ventas_mixtas: true,
      moneda_habitual: "USD",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok ? r.rows![0] : {}).toMatchObject({
      estado_contribuyente: "ACTIVO",
      condicion_contribuyente: "HABIDO",
      regimen: "rmt",
      zona: "amazonia",
      ventas_exoneradas: true,
      ventas_mixtas: true,
      moneda_habitual: "USD",
    });
  });
});

describe("CHECK de cliente (D1, CA-4)", () => {
  it.each(["rg", "rmt", "rer", "nrus"])("regimen %s es valido", async (regimen) => {
    expect((await insertar({ regimen })).ok).toBe(true);
  });

  it("regimen NULL (sin definir) es valido", async () => {
    expect((await insertar({ regimen: null })).ok).toBe(true);
  });

  it.each(["", "RG", "general", "mype", "rmt "])("regimen fuera del catalogo (%j) se rechaza con CHECK", async (regimen) => {
    const r = await insertar({ regimen });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(SQLSTATE_CHECK);
  });

  it.each(["general", "amazonia"])("zona %s es valida", async (zona) => {
    expect((await insertar({ zona })).ok).toBe(true);
  });

  it.each(["", "Amazonia", "selva", "frontera"])("zona fuera del catalogo (%j) se rechaza con CHECK", async (zona) => {
    const r = await insertar({ zona });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(SQLSTATE_CHECK);
  });

  it.each(["PEN", "USD"])("moneda_habitual %s es valida", async (moneda_habitual) => {
    expect((await insertar({ moneda_habitual })).ok).toBe(true);
  });

  it.each(["", "EUR", "pen", "usd", "S/"])("moneda_habitual fuera del catalogo (%j) se rechaza con CHECK", async (moneda_habitual) => {
    const r = await insertar({ moneda_habitual });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(SQLSTATE_CHECK);
  });

  it.each(["zona", "moneda_habitual", "ventas_exoneradas", "ventas_mixtas"])("%s es NOT NULL", async (columna) => {
    const r = await insertar({ [columna]: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(SQLSTATE_NOT_NULL);
  });

  describe.each(["estado_contribuyente", "condicion_contribuyente"])("%s (texto 1-50, nulo hasta que 007b lo consulte)", (columna) => {
    it("NULL, 1 caracter y 50 caracteres son validos", async () => {
      for (const v of [null, "A", "X".repeat(50)]) {
        const r = await insertar({ [columna]: v });
        expect(r.ok, `${columna}=${v === null ? "null" : v.length}: ${JSON.stringify(r)}`).toBe(true);
      }
    });

    it("la cadena vacia y 51 caracteres se rechazan con CHECK", async () => {
      for (const v of ["", "X".repeat(51)]) {
        const r = await insertar({ [columna]: v });
        expect(r.ok, `${columna} de largo ${v.length} debia rechazarse`).toBe(false);
        if (!r.ok) expect(r.code).toBe(SQLSTATE_CHECK);
      }
    });
  });

  describe("razon_social (1-200)", () => {
    it("1 y 200 caracteres son validos", async () => {
      for (const v of ["A", "R".repeat(200)]) {
        const r = await insertar({}, v);
        expect(r.ok, `largo ${v.length}: ${JSON.stringify(r)}`).toBe(true);
      }
    });

    it("la cadena vacia y 201 caracteres se rechazan con CHECK", async () => {
      for (const v of ["", "R".repeat(201)]) {
        const r = await insertar({}, v);
        expect(r.ok, `razon social de largo ${v.length} debia rechazarse`).toBe(false);
        if (!r.ok) expect(r.code).toBe(SQLSTATE_CHECK);
      }
    });

    it("la razon social provisional 'RUC <numero>' (D1) es valida", async () => {
      expect((await insertar({}, `RUC ${RUC_PRUEBA}`)).ok).toBe(true);
    });
  });

  it("archivado_at acepta una fecha y NULL", async () => {
    expect((await insertar({ archivado_at: new Date() })).ok).toBe(true);
    expect((await insertar({ archivado_at: null })).ok).toBe(true);
  });
});

describe("indice parcial de clientes activos (D1)", () => {
  it("existe un indice no unico (tenant_id) WHERE archivado_at IS NULL", async () => {
    const r = await admin.query(
      `select i.relname as nombre, x.indisunique as unico, pg_get_indexdef(x.indexrelid) as def
         from pg_index x
         join pg_class c on c.oid = x.indrelid
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         join pg_class i on i.oid = x.indexrelid
        where c.relname = 'cliente' and x.indpred is not null`,
    );
    const activos = r.rows.filter((f) => /\(tenant_id\)\s+WHERE \(?\(?archivado_at IS NULL\)?\)?/.test(String(f.def)));
    expect(activos.map((f) => f.def), "indice parcial de activos por estudio").toHaveLength(1);
    expect(activos[0].unico).toBe(false);
  });

  it("el planificador puede usarlo: el predicado es el mismo que usan contarRucs y el listado", async () => {
    const r = await admin.query(
      `select pg_get_expr(x.indpred, x.indrelid) as pred
         from pg_index x join pg_class c on c.oid = x.indrelid
        where c.relname = 'cliente' and x.indpred is not null`,
    );
    expect(r.rows.map((f) => String(f.pred).replace(/[()\s]/g, ""))).toContain("archivado_atISNULL");
  });
});

describe("UNIQUE (tenant_id, ruc) cuenta tambien a los archivados (D4, CA-2)", () => {
  it("un RUC repetido con el existente archivado da 23505; con el existente activo tambien", async () => {
    const x = await ea.estudio();
    const id = await ea.cliente(x.id);
    const ruc = (await admin.query("select ruc from cliente where id = $1", [id])).rows[0].ruc as string;
    await enTx(admin, null, async (c) => {
      await c.query("update cliente set archivado_at = now() where id = $1", [id]);
      const dup = await probar(c, "insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, 'Duplicado')", [x.id, ruc]);
      expect(dup.ok, "el RUC de un archivado sigue ocupado").toBe(false);
      if (!dup.ok) expect(dup.code).toBe("23505");
      await c.query("update cliente set archivado_at = null where id = $1", [id]);
      const dup2 = await probar(c, "insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, 'Duplicado')", [x.id, ruc]);
      expect(dup2.ok).toBe(false);
      if (!dup2.ok) expect(dup2.code).toBe("23505");
    });
  });

  it("el mismo RUC en otro estudio sigue permitido aunque el primero este archivado", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const id = await ea.cliente(x.id);
    const ruc = (await admin.query("select ruc from cliente where id = $1", [id])).rows[0].ruc as string;
    await enTx(admin, null, async (c) => {
      await c.query("update cliente set archivado_at = now() where id = $1", [id]);
      const r = await probar(c, "insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, 'Otro estudio')", [y.id, ruc]);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });
  });
});

describe("catalogo: RLS y grants de cliente se mantienen (D1: sin grants nuevos)", () => {
  it("cliente conserva RLS ENABLE + FORCE y solo la politica tenant_isolation FOR ALL sobre app.tenant_id", async () => {
    const t = (await admin.query("select relrowsecurity as rls, relforcerowsecurity as forzada from pg_class where oid = 'public.cliente'::regclass")).rows[0];
    expect(t).toEqual({ rls: true, forzada: true });
    const pols = (
      await admin.query("select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'cliente'")
    ).rows;
    expect(pols.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
    expect(pols[0].cmd).toBe("ALL");
    expect(String(pols[0].qual)).toContain("app.tenant_id");
    expect(String(pols[0].with_check)).toContain("app.tenant_id");
  });

  it("las columnas nuevas existen y NINGUNA columna de cliente lleva grants por columna: son de tabla", async () => {
    const nuevas = (
      await admin.query(
        "select count(*)::int as n from pg_attribute where attrelid = 'public.cliente'::regclass and attname = any($1::text[]) and not attisdropped",
        [COLUMNAS_NUEVAS],
      )
    ).rows[0].n;
    expect(nuevas, "la migracion 0026 aun no agrega las columnas").toBe(COLUMNAS_NUEVAS.length);
    const conAcl = (
      await admin.query("select attname from pg_attribute where attrelid = 'public.cliente'::regclass and attacl is not null and not attisdropped")
    ).rows;
    expect(conAcl.map((f) => f.attname)).toEqual([]);
  });

  it.each(ROLES_APP)("%s conserva SELECT, INSERT, UPDATE y DELETE de tabla y las columnas nuevas quedan cubiertas", async (rol) => {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const r = await admin.query("select has_table_privilege($1, 'public.cliente', $2) as ok", [rol, priv]);
      expect(r.rows[0].ok, `${rol} ${priv}`).toBe(true);
    }
    for (const col of COLUMNAS_NUEVAS) {
      const r = await admin.query(
        "select has_column_privilege($1, 'public.cliente', $2, 'UPDATE') as u, has_column_privilege($1, 'public.cliente', $2, 'SELECT') as s",
        [rol, col],
      );
      expect(r.rows[0], `${rol}.${col}`).toEqual({ u: true, s: true });
    }
  });

  it.each(["contapp_auth", "contapp_platform", "contapp_app"])("%s no gana acceso a cliente con las columnas nuevas", async (rol) => {
    const r = await admin.query("select has_table_privilege($1, 'public.cliente', 'SELECT') as ok", [rol]);
    expect(r.rows[0].ok).toBe(false);
  });
});

describe.each(ROLES_APP)("RLS efectiva sobre archivado_at (rol %s)", (rolApp) => {
  let db: ContappDb;
  let x: string;
  let y: string;
  let cx: string;
  let cy: string;
  beforeAll(async () => {
    db = crearDb(rolApp, 2);
    x = (await ea.estudio()).id;
    y = (await ea.estudio()).id;
    cx = await ea.cliente(x);
    cy = await ea.cliente(y);
    await admin.query("update cliente set archivado_at = now() where id = any($1::uuid[])", [[cx, cy]]);
  });
  afterAll(async () => {
    await db?.close();
  });

  it("el estudio ve su cliente archivado (y su fecha) pero no el archivado de otro estudio", async () => {
    const propio = await db.withTenant({ tenantId: x }, async (tx) => (await tx.query("select id, archivado_at from cliente where id = $1", [cx])).rows);
    expect(propio).toHaveLength(1);
    expect(propio[0].archivado_at).toBeInstanceOf(Date);
    const ajeno = await db.withTenant({ tenantId: x }, async (tx) => (await tx.query("select id from cliente where id = $1", [cy])).rows);
    expect(ajeno).toEqual([]);
  });

  it("archivar o reactivar un cliente ajeno no toca ninguna fila y el ajeno no cambia", async () => {
    const r = await intentar(db, { tenantId: x }, "update cliente set archivado_at = null where id = $1", [cy]);
    expect(r).toEqual({ ok: true, rowCount: 0 });
    const r2 = await intentar(db, { tenantId: x }, "update cliente set archivado_at = now() where id = $1", [cx]);
    expect(r2).toEqual({ ok: true, rowCount: 1 });
    const sigue = (await admin.query("select archivado_at from cliente where id = $1", [cy])).rows[0].archivado_at;
    expect(sigue).not.toBeNull();
  });

  it("insertar un cliente con archivado_at en otro estudio viola la RLS (42501)", async () => {
    const r = await intentar(
      db,
      { tenantId: x },
      "insert into cliente (tenant_id, ruc, razon_social, archivado_at) values ($1, '29999999992', 'Ajeno', now())",
      [y],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("42501");
  });
});

describe("el seed no se rompe con el esquema nuevo", () => {
  it("los clientes del seed quedan activos, con perfil por defecto y razon social valida", async () => {
    const s = semilla();
    const ids = [...clientesDe("A"), ...clientesDe("B")].map((c) => c.id);
    expect(ids.length).toBe(6);
    expect(s.tenantA).not.toBe(s.tenantB);
    const r = await admin.query(
      `select count(*)::int as n,
              count(*) filter (where archivado_at is null and zona = 'general' and moneda_habitual = 'PEN'
                                 and not ventas_exoneradas and not ventas_mixtas and regimen is null)::int as por_defecto
         from cliente where id = any($1::uuid[])`,
      [ids],
    );
    expect(r.rows[0]).toEqual({ n: 6, por_defecto: 6 });
  });
});
