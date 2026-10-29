// Spec 008 · T13b (ronda adversarial 1b, caja blanca): funciones de 0018 con argumentos extremos y el rol
// contapp_enumerador visto como atacante. Todo corre en transacciones que se revierten (no deja datos en la BD).
//
// Hallazgo que fija (rojo):
//  - auth.purgar valida "retención ≥ 1 día" comparando intervalos (un mes = 30 días), pero corta con aritmética de
//    calendario (now() - retención). Un intervalo con meses negativos y días positivos ('-12 mon 361 days') pasa la
//    validación (= 1 día) y deja el corte en el FUTURO (≈ now() + 4 días): borra todas las sesiones VIGENTES
//    (expira_absoluta < corte). CA-13/D16: "no toca sesiones vigentes".
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";

let admin: Pool;

beforeAll(() => {
  admin = abrirAdmin(2);
});
afterAll(async () => {
  await admin?.end();
});

/** Ejecuta `fn` en una transacción del superusuario que SIEMPRE se revierte. */
async function enRollback<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

describe("auth.purgar con retenciones de signo mixto (D16, CA-13)", () => {
  it("una retención '-12 mon 361 days' (que compara como 1 día) no borra una sesión vigente", async () => {
    const r = await enRollback(async (c) => {
      const u = await c.query(
        "insert into usuario (email, nombre) values ('r1b-purgar-' || gen_random_uuid() || '@prueba.contapp.test', 'r1b') returning id",
      );
      const s = await c.query(
        `insert into auth.sesion (token_hash, usuario_id, expira_absoluta)
         values (sha256(gen_random_uuid()::text::bytea), $1, now() + interval '12 hours') returning id`,
        [u.rows[0].id],
      );
      const sesionId = s.rows[0].id as string;
      // La validación de la función (retención >= 1 día) acepta este valor:
      const cmp = await c.query(
        "select '-12 mon 361 days'::interval >= interval '1 day' as pasa",
      );
      expect(cmp.rows[0].pasa).toBe(true);
      await c.query("SET LOCAL ROLE contapp_worker");
      let error: string | null = null;
      try {
        await c.query("SAVEPOINT p");
        await c.query(
          "select * from auth.purgar('-12 mon 361 days'::interval, '1000 years'::interval, '1000 years'::interval, '1000 years'::interval)",
        );
      } catch (e) {
        error = String((e as { code?: string }).code);
        await c.query("ROLLBACK TO SAVEPOINT p");
      }
      await c.query("RESET ROLE");
      const sigue = await c.query(
        "select count(*)::int as n from auth.sesion where id = $1",
        [sesionId],
      );
      return { error, sigue: sigue.rows[0].n as number };
    });
    // O la función rechaza la retención (22023), o la sesión vigente sigue ahí.
    if (r.error === null)
      expect(r.sigue, "auth.purgar borró una sesión vigente").toBe(1);
    else expect(r.error).toBe("22023");
  });
});

describe("contapp_enumerador como atacante (D18)", () => {
  it("solo puede leer tenant(id) y job_registro(tenant_id, estado, actualizado_en); sin CREATE, TEMP ni miembros", async () => {
    const r = await enRollback(async (c) => {
      const tablas = await c.query(
        `select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','v','m','p','f','S') and n.nspname not in ('pg_catalog','information_schema')
            and has_table_privilege('contapp_enumerador', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`,
      );
      const columnas = await c.query(
        `select n.nspname || '.' || c.relname || '.' || a.attname as col
           from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          where a.attnum > 0 and not a.attisdropped and c.relkind in ('r','v','m','p','f')
            and n.nspname not in ('pg_catalog','information_schema')
            and has_column_privilege('contapp_enumerador', c.oid, a.attnum, 'SELECT,INSERT,UPDATE,REFERENCES')
          order by 1`,
      );
      const esquemas = await c.query(
        `select nspname from pg_namespace where has_schema_privilege('contapp_enumerador', oid, 'CREATE')`,
      );
      const bd = await c.query(
        `select has_database_privilege('contapp_enumerador', current_database(), 'TEMP') as temp,
                has_database_privilege('contapp_enumerador', current_database(), 'CREATE') as crear`,
      );
      const miembros = await c.query(
        `select count(*)::int as n from pg_auth_members
          where roleid = 'contapp_enumerador'::regrole or member = 'contapp_enumerador'::regrole`,
      );
      const rol = await c.query(
        `select rolcanlogin, rolsuper, rolinherit, rolbypassrls from pg_roles where rolname = 'contapp_enumerador'`,
      );
      return {
        tablas: tablas.rows.map((x) => x.t as string),
        columnas: columnas.rows.map((x) => x.col as string),
        esquemas: esquemas.rows.map((x) => x.nspname as string),
        bd: bd.rows[0],
        miembros: miembros.rows[0].n as number,
        rol: rol.rows[0],
      };
    });
    expect(r.tablas).toEqual([]);
    expect(r.columnas).toEqual([
      "public.job_registro.actualizado_en",
      "public.job_registro.estado",
      "public.job_registro.tenant_id",
      "public.tenant.id",
    ]);
    expect(r.esquemas).toEqual([]);
    expect(r.bd).toEqual({ temp: false, crear: false });
    expect(r.miembros).toBe(0);
    expect(r.rol).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolinherit: false,
      rolbypassrls: true,
    });
  });
});
