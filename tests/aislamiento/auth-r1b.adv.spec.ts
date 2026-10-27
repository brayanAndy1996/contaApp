// Spec 004 · ronda adversarial 1b (BD, caja blanca sobre 0007_auth.sql). Todo corre en transacciones que se
// revierten: no deja filas. Si una prueba falla es un hallazgo (tasks.md, sección T15b).
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CorreoNoAsciiError, normalizarCorreo } from "../../packages/shared/src/auth/correo";
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

describe("r1b · correos no ASCII (D13: solo ASCII, dominios internacionales en punycode)", () => {
  // Reconvertida en T17a (ronda 2a). La versión de la ronda 1b (hallazgo H-r1b-4 / B4) afirmaba que `ß…` se
  // aceptaba y pedía que el CHECK rechazara solo lo que `toLowerCase()` de JS cambiaría (ẞ, İ). El usuario
  // decidió D13 (spec.md): los correos son solo ASCII. Ahora la prueba fija ese comportamiento aceptado: el
  // CHECK de usuario.email (0008) rechaza con 23514 todo correo no ASCII y `normalizarCorreo` lanza
  // `CorreoNoAsciiError`; así JS y `lower()` de PG no pueden divergir ni colisionar (ß / ẞ).
  const sufijo = () => `${randomBytes(5).toString("hex")}@t004.contapp.test`;

  it("el CHECK de usuario.email y normalizarCorreo rechazan todo correo no ASCII (ß, ẞ, İ, homoglifos); ASCII y punycode pasan", async () => {
    await enRollback(admin, null, async (c) => {
      const insertar = (email: string) => estado(c, "insert into usuario (email, nombre) values ($1, 'r1b')", [email]);
      expect(await insertar(`control-${sufijo()}`)).toBe("ok");
      expect(await insertar(`ana-${randomBytes(4).toString("hex")}@xn--estudio-zwa.pe`)).toBe("ok");
      expect(normalizarCorreo(`  Control-${sufijo().toUpperCase()} `)).toMatch(/^[\x20-\x7e]+$/);

      const noAscii: [string, string][] = [
        ["ß", `ß${sufijo()}`],
        ["ẞ", `ẞ${sufijo()}`],
        ["İ", `İlse-${sufijo()}`],
        ["ı sin punto", `ılse-${sufijo()}`],
        ["а cirílica", `pаypal-${sufijo()}`],
        ["ο griega", `gοogle-${sufijo()}`],
        ["ａ de ancho completo", `ａna-${sufijo()}`],
        ["ligadura ﬁ", `ﬁn-${sufijo()}`],
        ["e + acento combinante", `josé-${sufijo()}`],
        ["espacio de ancho cero", `ana​-${sufijo()}`],
        ["NBSP interno", `ana b-${sufijo()}`],
        ["dominio no ASCII", `ana-${randomBytes(4).toString("hex")}@estudiño.pe`],
      ];
      for (const [etq, email] of noAscii) {
        expect.soft(await insertar(email), `CHECK · ${etq}`).toBe("23514");
        expect.soft(() => normalizarCorreo(email), `normalizarCorreo · ${etq}`).toThrow(CorreoNoAsciiError);
      }

      // Invariante (no hay fila inalcanzable): lo que normalizarCorreo acepta es ASCII y la BD lo admite. Caso
      // límite: el signo Kelvin (U+212A) y el punto y coma griego (U+037E) se pliegan a ASCII ('k', ';') con
      // toLowerCase/NFC; caen en la misma cuenta que su forma ASCII (como las mayúsculas), no en otra.
      for (const entrada of [`Kelvin-${sufijo()}`, `a;b-${sufijo()}`]) {
        let salida: string | null = null;
        try {
          salida = normalizarCorreo(entrada);
        } catch (e) {
          expect(e).toBeInstanceOf(CorreoNoAsciiError);
        }
        if (salida !== null) {
          expect(salida).toMatch(/^[\x00-\x7f]+$/);
          expect(await insertar(salida)).toBe("ok");
        }
      }
    });
  });
});
