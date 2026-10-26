// CA-3 (catalogo): toda tabla con tenant_id tiene RLS ENABLE + FORCE y la politica tenant_isolation.
// Recorre pg_catalog, asi que una tabla nueva sin RLS rompe esta prueba.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirPool, TABLAS_NEGOCIO } from "./soporte";

// auth_definer (spec 004, CA-11) solo se admite como la define el plan: ver la prueba dedicada abajo.
const POLITICAS_PERMITIDAS = ["tenant_isolation", "membresia_por_usuario", "auth_definer"];

let pool: Pool;
beforeAll(() => {
  pool = abrirPool();
});
afterAll(async () => {
  await pool.end();
});

async function tablasConTenantId() {
  const r = await pool.query(
    `select c.relname as tabla, c.relrowsecurity as rls, c.relforcerowsecurity as forzada,
            a.attnotnull as no_nula, t.typname as tipo
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
       join pg_type t on t.oid = a.atttypid
      where c.relkind in ('r', 'p')
      order by c.relname`,
  );
  return r.rows as { tabla: string; rls: boolean; forzada: boolean; no_nula: boolean; tipo: string }[];
}

async function politicas() {
  const r = await pool.query(
    `select tablename, policyname, cmd, roles::text[] as roles, qual, with_check
       from pg_policies where schemaname = 'public' order by tablename, policyname`,
  );
  return r.rows as {
    tablename: string;
    policyname: string;
    cmd: string;
    roles: string[];
    qual: string | null;
    with_check: string | null;
  }[];
}

describe("CA-3 catalogo de RLS", () => {
  it("el catalogo incluye las tablas de negocio del esquema base (la prueba no es vacua)", async () => {
    const nombres = (await tablasConTenantId()).map((t) => t.tabla);
    for (const t of TABLAS_NEGOCIO) expect(nombres).toContain(t);
  });

  it("toda tabla con tenant_id tiene RLS ENABLE y FORCE", async () => {
    const tablas = await tablasConTenantId();
    expect(tablas.length).toBeGreaterThan(0);
    const mal = tablas.filter((t) => !t.rls || !t.forzada).map((t) => t.tabla);
    expect(mal, "tablas con tenant_id sin RLS ENABLE+FORCE").toEqual([]);
  });

  it("toda tabla con tenant_id tiene la politica tenant_isolation FOR ALL con USING y WITH CHECK sobre app.tenant_id", async () => {
    const tablas = await tablasConTenantId();
    expect(tablas.length).toBeGreaterThan(0);
    const pols = await politicas();
    const sin: string[] = [];
    for (const t of tablas) {
      const p = pols.find((x) => x.tablename === t.tabla && x.policyname === "tenant_isolation");
      if (!p || p.cmd !== "ALL" || !p.qual?.includes("app.tenant_id") || !p.with_check?.includes("app.tenant_id")) {
        sin.push(t.tabla);
      }
    }
    expect(sin, "tablas sin tenant_isolation correcta").toEqual([]);
  });

  it("solo existen las politicas permitidas y membresia_por_usuario es solo SELECT en membresia", async () => {
    const pols = await politicas();
    expect(pols.length).toBeGreaterThan(0);
    const raras = pols.filter((p) => !POLITICAS_PERMITIDAS.includes(p.policyname));
    expect(raras.map((p) => `${p.tablename}.${p.policyname}`)).toEqual([]);
    for (const p of pols.filter((x) => x.policyname === "membresia_por_usuario")) {
      expect(p.tablename).toBe("membresia");
      expect(p.cmd).toBe("SELECT");
    }
    expect(pols.some((p) => p.tablename === "membresia" && p.policyname === "membresia_por_usuario")).toBe(true);
  });

  it("auth_definer (spec 004) existe solo en usuario y membresia, es SELECT, solo para contapp_auth y USING (true)", async () => {
    const pols = (await politicas()).filter((p) => p.policyname === "auth_definer");
    expect(pols.map((p) => p.tablename).sort()).toEqual(["membresia", "usuario"]);
    for (const p of pols) {
      expect(p.cmd).toBe("SELECT");
      expect(p.roles).toEqual(["contapp_auth"]);
      expect(p.qual).toBe("true");
    }
  });

  it("tenant_id es uuid NOT NULL en toda tabla de negocio", async () => {
    const tablas = await tablasConTenantId();
    expect(tablas.length).toBeGreaterThan(0);
    const mal = tablas.filter((t) => t.tipo !== "uuid" || !t.no_nula).map((t) => t.tabla);
    expect(mal).toEqual([]);
  });

  it("las tablas de plataforma (tenant, usuario) existen y no tienen tenant_id", async () => {
    const r = await pool.query(
      `select c.relname
         from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind in ('r','p') and c.relname in ('tenant', 'usuario')`,
    );
    expect(r.rows.map((x) => x.relname).sort()).toEqual(["tenant", "usuario"]);
    const con = (await tablasConTenantId()).map((t) => t.tabla);
    expect(con).not.toContain("tenant");
    expect(con).not.toContain("usuario");
  });

  it("toda tabla de public pertenece a contapp_migrator", async () => {
    const r = await pool.query(
      `select c.relname as tabla, o.rolname as dueno
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         join pg_roles o on o.oid = c.relowner
        where c.relkind in ('r', 'p')
        order by c.relname`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(4);
    const ajenas = r.rows.filter((x) => x.dueno !== "contapp_migrator").map((x) => `${x.tabla}:${x.dueno}`);
    expect(ajenas).toEqual([]);
  });
});
