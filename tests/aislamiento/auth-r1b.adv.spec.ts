// Spec 004 · ronda adversarial 1b (BD, caja blanca sobre 0007_auth.sql). Todo corre en transacciones que se
// revierten: no deja filas. Si una prueba falla es un hallazgo (tasks.md, sección T15b).
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, abrirApp } from "./auth-soporte";
import { semilla } from "./soporte";

let app: Pool; // contapp_app (miembro de contapp_backend)
let admin: Pool; // conexión de migraciones (solo para la prueba de CHECK, con ROLLBACK)
beforeAll(() => {
  app = abrirApp(2);
  admin = abrirAdmin(2);
});
afterAll(async () => {
  await app?.end();
  await admin?.end();
});

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest();

/** Ejecuta `sql` en un SAVEPOINT y devuelve el SQLSTATE (o "ok"). */
async function estado(c: PoolClient, sql: string, valores: unknown[] = []): Promise<string> {
  await c.query("SAVEPOINT p");
  try {
    await c.query(sql, valores);
    await c.query("RELEASE SAVEPOINT p");
    return "ok";
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT p");
    return String((e as { code?: string }).code ?? "?");
  }
}
async function enRollback<T>(pool: Pool, rol: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (rol) await c.query(`SET LOCAL ROLE ${rol}`);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

describe("r1b · funciones SECURITY DEFINER frente a pg_temp, search_path hostil y escalada", () => {
  it("objetos en pg_temp no desvían login_preparar y contapp_backend no escala a contapp_auth ni crea objetos que las funciones usen", async () => {
    const s = semilla() as unknown as { uA: string; usuarios: { id: string; email: string }[] };
    const correoA = s.usuarios.find((u) => u.id === s.uA)!.email;
    await enRollback(app, "contapp_backend", async (c) => {
      // search_path hostil del llamador: las funciones fijan el suyo y califican los nombres.
      await c.query("set local search_path = public, auth");
      const clave = sha256(`r1b-${randomBytes(8).toString("hex")}`);
      const r = await c.query("select * from auth.login_preparar($1, $2)", [correoA, clave]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].permitido).toBe(true);
      expect(r.rows[0].usuario_id).toBe(s.uA);
      expect(String(r.rows[0].hash)).toMatch(/^\$argon2id\$v=19\$/);

      // Sin sombras en pg_temp ni escalada: cada intento en su SAVEPOINT; todos deben dar 42501.
      const intentos: [string, string][] = [
        ["tabla temporal que sombree usuario", "create temp table usuario (id uuid, email text)"],
        ["función en pg_temp", "create function pg_temp.now() returns timestamptz language sql as $$ select '2000-01-01'::timestamptz $$"],
        ["set role contapp_auth", "SET ROLE contapp_auth"],
        ["set session authorization", "SET SESSION AUTHORIZATION contapp_auth"],
        ["crear función en auth", "create function auth.r1b() returns int language sql as $$ select 1 $$"],
        ["crear tabla en public", "create table public.r1b_x (a int)"],
        ["reemplazar public.uuid_v7", "create or replace function public.uuid_v7() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000000'::uuid $$"],
        ["cambiar dueño de una función", "alter function auth.login_preparar(text, bytea) owner to contapp_backend"],
        ["cambiar search_path de una función", "alter function auth.login_preparar(text, bytea) set search_path = public"],
        ["leer hashes directamente", "select hash from auth.usuario_contrasena"],
      ];
      const resultados: Record<string, string> = {};
      for (const [nombre, sql] of intentos) resultados[nombre] = await estado(c, sql);
      expect(resultados).toEqual(Object.fromEntries(intentos.map(([n]) => [n, "42501"])));

      // GRANT sin opción de concesión solo avisa (WARNING): comprobar que no cambió nada.
      const acl = async () =>
        (await c.query("select proacl::text a from pg_proc where oid = 'auth.login_preparar(text, bytea)'::regprocedure")).rows[0].a;
      const antes = await acl();
      await estado(c, "grant execute on function auth.login_preparar(text, bytea) to public, contapp_worker");
      expect(await acl()).toBe(antes);
      const w = await c.query("select has_function_privilege('contapp_worker', 'auth.login_preparar(text, bytea)', 'EXECUTE') x");
      expect(w.rows[0].x).toBe(false);
    });
  });
});

describe("r1b · correos no ASCII: normalizarCorreo (JS) frente a lower() de PostgreSQL (D10, riesgo del plan)", () => {
  // normalizarCorreo = trim -> toLowerCase -> NFC. La BD debe rechazar (CHECK) todo correo que esa función
  // cambiaría; si no, la fila es inalcanzable por login/recuperación o dos filas colisionan en la misma clave.
  const sufijo = () => `${randomBytes(5).toString("hex")}@t004.contapp.test`;
  const js = (c: string) => c.trim().toLowerCase().normalize("NFC");

  it("rechaza correos que JS normalizaría distinto (ẞ, İ) y no admite dos filas con la misma forma normalizada", async () => {
    await enRollback(admin, null, async (c) => {
      const insertar = (email: string) => estado(c, "insert into usuario (email, nombre) values ($1, 'r1b')", [email]);
      const control = `control-${sufijo()}`;
      expect(await insertar(control)).toBe("ok");

      for (const email of [`ẞe-${sufijo()}`, `İlse-${sufijo()}`]) {
        expect(js(email)).not.toBe(email); // la prueba no es vacua: JS sí lo cambia
        expect.soft(await insertar(email), `CHECK con ${JSON.stringify(email.slice(0, 6))}`).not.toBe("ok");
      }

      const s = sufijo();
      expect(js(`ẞ${s}`)).toBe(js(`ß${s}`));
      expect(await insertar(`ß${s}`)).toBe("ok");
      expect.soft(await insertar(`ẞ${s}`), "duplicado por normalización (ß / ẞ)").not.toBe("ok");
    });
  });
});
