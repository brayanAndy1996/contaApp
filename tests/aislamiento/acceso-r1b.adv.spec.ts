// Spec 005 · T14b · ronda adversarial 1b (escenarios nuevos, caja blanca), capa de BD. Solo afirma el
// comportamiento seguro esperado; si una prueba falla es un hallazgo (tasks.md, Resultado de T14b).
// Estudios, usuarios e invitaciones propios (EscenarioAcceso, borrados al final); toda escritura de prueba va
// en una transacción con ROLLBACK, salvo las funciones `auth.*`, cuyos efectos borra la limpieza.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAcceso, sha256 } from "./acceso-soporte";
import { abrirAdmin, abrirApp, hashFalso, llamar, nuevoToken } from "./auth-soporte";
import type { Intento } from "./soporte";

let app: Pool;
let admin: Pool;
let ea: EscenarioAcceso;

beforeAll(() => {
  app = abrirApp(6);
  admin = abrirAdmin(4);
  ea = new EscenarioAcceso(admin);
});
afterAll(async () => {
  await ea?.limpiar();
  await app?.end();
  await admin?.end();
});

/** Con el rol de login (contapp_app): SET LOCAL ROLE `rol`, estudio fijado y una sentencia; siempre ROLLBACK. */
async function comoRol(rol: string, tenantId: string | null, sql: string, v: unknown[] = []): Promise<Intento> {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${rol}`);
    if (tenantId) await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, v);
    return { ok: true, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: String(err.code ?? ""), message: String(err.message ?? "") };
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}
const codigo = (r: Intento): string => (r.ok ? "ok" : r.code);
const duenosActivos = async (t: string): Promise<number> =>
  (
    await admin.query(
      "select count(*)::int as n from membresia where tenant_id = $1 and rol = 'dueno' and desactivada_en is null",
      [t],
    )
  ).rows[0].n;

describe("T14b · trigger del último Dueño fuera del camino del backend", () => {
  it("contapp_worker (que tiene UPDATE/DELETE en membresia) tampoco deja el estudio sin Dueño", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    await ea.miembro(x.id, "admin");
    const ops: Record<string, string> = {
      degradar: "update membresia set rol = 'admin' where usuario_id = $1",
      desactivar: "update membresia set desactivada_en = now() where usuario_id = $1",
      borrar: "delete from membresia where usuario_id = $1",
      "borrar todo el estudio": "delete from membresia where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and $1::uuid is not null",
    };
    const vistos: Record<string, string> = {};
    for (const [n, sql] of Object.entries(ops)) vistos[n] = codigo(await comoRol("contapp_worker", x.id, sql, [d.id]));
    expect(vistos).toEqual(Object.fromEntries(Object.keys(ops).map((n) => [n, "P0001"])));
    expect(await duenosActivos(x.id)).toBe(1);
  });

  it("mover al único Dueño a otro estudio (UPDATE de tenant_id) falla para el backend y aun para el superusuario", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const mover = "update membresia set tenant_id = $2 where usuario_id = $1 and tenant_id = $3";
    const r = await comoRol("contapp_backend", x.id, mover, [d.id, y.id, x.id]);
    expect(r.ok).toBe(false);
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      const e = await c.query(mover, [d.id, y.id, x.id]).catch((err) => err);
      expect((e as { code?: string }).code).toBe("P0001");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    expect(await duenosActivos(x.id)).toBe(1);
  });
});

describe("T14b · superficie de contapp_auth y de las funciones SECURITY DEFINER nuevas", () => {
  it("nadie de la app puede asumir contapp_auth (sus políticas INSERT WITH CHECK (true) solo valen dentro de las funciones)", async () => {
    const vistos: Record<string, string> = {};
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      const c = await app.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE ${rol}`);
        const e = await c.query("SET LOCAL ROLE contapp_auth").then(
          () => ({ code: "ok" }),
          (err) => err,
        );
        vistos[rol] = String((e as { code?: string }).code);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
    const directo = await app.connect();
    try {
      vistos.contapp_app = String(
        ((await directo.query("SET ROLE contapp_auth").then(() => ({ code: "ok" }), (err) => err)) as { code?: string }).code,
      );
    } finally {
      await directo.query("RESET ROLE").catch(() => undefined);
      directo.release(true);
    }
    expect(vistos).toEqual({ contapp_backend: "42501", contapp_worker: "42501", contapp_app: "42501" });
  });

  it("los roles de la app no pueden crear objetos para secuestrar el search_path (temp, public ni auth)", async () => {
    const intentos: Record<string, string> = {};
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      intentos[`${rol} temp`] = codigo(await comoRol(rol, null, "create temp table invitacion (x int)"));
      intentos[`${rol} public`] = codigo(await comoRol(rol, null, "create table public.r1b_trampa (x int)"));
      intentos[`${rol} auth`] = codigo(await comoRol(rol, null, "create function auth.r1b_trampa() returns int language sql as 'select 1'"));
    }
    for (const [k, v] of Object.entries(intentos)) expect({ k, v }).toEqual({ k, v: "42501" });
  });

  it("invitacion_aceptar_nueva no crea cuentas con nombre vacío, en blanco, con caracteres de control o enorme", async () => {
    const x = await ea.estudio();
    const dueno = await ea.miembro(x.id, "dueno");
    const resultados: Record<string, string> = {};
    const nombres: Record<string, string> = {
      vacio: "",
      blanco: "   ",
      control: "\u0007\u001b[31m",
      enorme: "a".repeat(10_000),
    };
    for (const [k, nombre] of Object.entries(nombres)) {
      const inv = await ea.invitacion(x.id, { invitadoPor: dueno.id, rol: "lectura" });
      const r = await llamar(app, "select auth.invitacion_aceptar_nueva($1, $2, $3) as r", [inv.tokenHash, nombre, hashFalso()]);
      const creado = (await admin.query("select count(*)::int as n from usuario where email = $1", [inv.correo])).rows[0].n;
      resultados[k] = r.ok ? `${r.rows[0].r}/${creado}` : `error/${creado}`;
    }
    // Valor: "<resultado de la función>/<cuentas creadas>". Seguro: ninguna cuenta creada.
    expect(resultados).toEqual(Object.fromEntries(Object.keys(nombres).map((k) => [k, expect.stringMatching(/\/0$/)])));
  });

  it("una invitación cuyo invitador ya no está activo en el estudio no crea membresía (aceptar_existente)", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const invitador = await ea.miembro(x.id, "admin");
    const inv = await ea.invitacion(x.id, { invitadoPor: invitador.id, rol: "admin" });
    await admin.query("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [x.id, invitador.id]);
    // Cuenta existente con el correo exacto de la invitación y una sesión viva.
    const u = await admin.query("insert into usuario (email, nombre) values ($1, 'Invitado r1b') returning id", [inv.correo]);
    const sesion = nuevoToken();
    await admin.query(
      "insert into auth.sesion (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta) values ($1, $2, null, now(), now(), now() + interval '1 hour')",
      [sha256(sesion), u.rows[0].id],
    );
    const r = await llamar(app, "select * from auth.invitacion_aceptar_existente($1, $2)", [inv.tokenHash, sha256(sesion)]);
    const m = await admin.query("select rol from membresia where tenant_id = $1 and usuario_id = $2", [x.id, u.rows[0].id]);
    expect({ ok: r.ok, filas: r.ok ? r.rows.length : 0, membresias: m.rows.length }).toEqual({ ok: true, filas: 0, membresias: 0 });
  });
});
