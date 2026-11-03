// Spec 004 · ronda adversarial 2a (T17a, BD): la migración 0008_auth_ronda1 es repetible y no amplía
// permisos. Corre la migración dos veces dentro de una transacción con la conexión de migraciones y la
// revierte (ROLLBACK): no deja cambios. Si falla es un hallazgo (tasks.md, sección T17a).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FUNCIONES_AUTH, FUNCIONES_AUTH_SOLO_WORKER, abrirAdmin } from "./auth-soporte";

let admin: Pool;
beforeAll(() => {
  admin = abrirAdmin(2);
});
afterAll(async () => {
  await admin?.end();
});

const MIGRACION = fileURLToPath(new URL("../../packages/db/migrations/0008_auth_ronda1.sql", import.meta.url));

/** Estado observable de seguridad del esquema auth: funciones, dueños, ACL explotada y CHECKs tocados. */
async function foto(c: PoolClient) {
  const funciones = (
    await c.query(`
      select p.oid::regprocedure::text as firma, pg_get_userbyid(p.proowner) as dueno, p.prosecdef as definer,
             coalesce(p.proconfig::text, '') as config, p.provolatile as volatil, md5(p.prosrc) as cuerpo
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'auth' order by 1`)
  ).rows;
  const acl = (
    await c.query(`
      select p.oid::regprocedure::text as firma,
             case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as a_quien,
             a.privilege_type as priv, a.is_grantable as reconcede
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
             lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where n.nspname = 'auth' order by 1, 2, 3`)
  ).rows.filter(
    // Ajuste de 008 (T3): 0008 termina con REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM contapp_worker y GRANT EXECUTE ON
    // ALL FUNCTIONS IN SCHEMA auth TO contapp_backend; reaplicarla dentro de esta transaccion le quitaria el EXECUTE al worker
    // y se lo daria al backend sobre auth.purgar (008, solo-worker). Reaplicar una migracion vieja no es un escenario real:
    // la ACL de purgar queda fuera de esta comparacion y la fija trabajos.spec.ts.
    (a) => !FUNCIONES_AUTH_SOLO_WORKER.some((n) => String(a.firma).startsWith(`auth.${n}(`)),
  );
  const checks = (
    await c.query(`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('usuario_email_normalizado', 'limite_tasa_tipo_valido') order by 1`)
  ).rows;
  return { funciones, acl, checks };
}

describe("r2a · migración 0008_auth_ronda1", () => {
  it("aplicada dos veces más no cambia nada y deja EXECUTE solo para contapp_backend (dueño contapp_auth)", async () => {
    const sentencias = readFileSync(MIGRACION, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(sentencias.length).toBeGreaterThan(5);

    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '20s'");
      const antes = await foto(c);
      for (let vuelta = 1; vuelta <= 2; vuelta++) {
        for (const [i, s] of sentencias.entries()) {
          await c.query("SAVEPOINT m");
          try {
            await c.query(s);
            await c.query("RELEASE SAVEPOINT m");
          } catch (e) {
            await c.query("ROLLBACK TO SAVEPOINT m");
            expect.fail(`vuelta ${vuelta}, sentencia ${i + 1}: SQLSTATE ${String((e as { code?: string }).code)}`);
          }
        }
      }
      const despues = await foto(c);
      expect(despues).toEqual(antes);

      // Ninguna función de auth fuera de la lista: el GRANT ... ON ALL FUNCTIONS no alcanza funciones internas.
      const nombres = [...new Set(despues.funciones.map((f) => String(f.firma).replace(/^auth\.|\(.*$/g, "")))].sort();
      expect(nombres).toEqual([...FUNCIONES_AUTH].sort());
      for (const f of despues.funciones) {
        expect.soft(f.dueno, `${f.firma}: dueño`).toBe("contapp_auth");
        expect.soft(f.definer, `${f.firma}: SECURITY DEFINER`).toBe(true);
        expect.soft(f.config, `${f.firma}: search_path fijo`).toBe('{"search_path=pg_catalog, pg_temp"}');
      }
      // ACL: por función, solo el dueño y contapp_backend; nada a PUBLIC, worker, platform ni contapp_app; sin reconceder.
      // Ajuste de 008 (T3): las de FUNCIONES_AUTH_SOLO_WORKER (auth.purgar) van solo al dueño y a contapp_worker.
      const soloWorker = (firma: unknown) =>
        FUNCIONES_AUTH_SOLO_WORKER.some((n) => String(firma).startsWith(`auth.${n}(`));
      const ajenos = despues.acl.filter((a) =>
        soloWorker(a.firma)
          ? !["contapp_auth", "contapp_worker"].includes(String(a.a_quien))
          : !["contapp_auth", "contapp_backend"].includes(String(a.a_quien)),
      );
      expect(ajenos).toEqual([]);
      const backend = despues.acl.filter((a) => a.a_quien === "contapp_backend");
      expect(backend.map((a) => a.priv)).toEqual(
        Array(FUNCIONES_AUTH.length - FUNCIONES_AUTH_SOLO_WORKER.length).fill("EXECUTE"),
      );
      expect(backend.some((a) => a.reconcede)).toBe(false);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});
