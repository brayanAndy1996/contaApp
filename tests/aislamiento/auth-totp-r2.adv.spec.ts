// Spec 029 · T15 · Ronda adversarial 2 (BD). Ataques contra las correcciones de T14 (0080): el bloqueo por codigos
// (`auth.intento_login.bloqueo_codigo_hasta`), el bloqueo `auth.totp:<usuario>` entre `login_exito` y `totp_confirmar`, `totp_confirmar` con
// carreras de re-enrolamiento y las funciones heredadas con una sesion `pendiente`. Roles reales (`SET LOCAL ROLE contapp_*`); el superusuario
// solo siembra, retiene transacciones y lee. Secretos, codigos y hashes sinteticos.
import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioTotp, PASO, SQL, abrirAdmin, abrirApp, diez, exito, llamar, nuevoToken, tenantDe } from "./auth-totp-soporte";
import { hashFalso } from "./auth-soporte";

let app: Pool;
let admin: Pool;
let esc: EscenarioTotp;
beforeAll(() => {
  app = abrirApp(30);
  admin = abrirAdmin(6);
  esc = new EscenarioTotp(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});
const A = () => tenantDe("A");
const ROTAR = "select * from auth.sesion_rotar($1::bytea, $2::bytea, $3::uuid)";
const CONSUMIR = "select * from auth.recuperacion_consumir($1::bytea, $2::text)";

async function esperarBloqueo(patron: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await admin.query(
      "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like $1",
      [`%${patron}%`],
    );
    if (r.rows[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("la sentencia no llego a esperar el bloqueo");
}

/** Abre una transaccion como contapp_backend y ejecuta `sql` sin confirmar: la fila queda retenida hasta `fin`. */
async function retener(sql: string, valores: unknown[]): Promise<{ filas: any[]; fin: (ok: boolean) => Promise<void> }> {
  const c: PoolClient = await app.connect();
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE contapp_backend");
  const r = await c.query(sql, valores);
  return {
    filas: r.rows,
    fin: async (ok) => {
      try {
        await c.query(ok ? "COMMIT" : "ROLLBACK");
      } finally {
        c.release();
      }
    },
  };
}

describe("T15 · el bloqueo por codigos y el contador (CA-3, CA-4)", () => {
  it("restablecer la contrasena con 4 codigos erroneos acumulados no reinicia el contador: el 5.º (tras el nuevo login) bloquea", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    for (let i = 0; i < 4; i++) expect((await exito(llamar(app, SQL.reservar, [p.token])))[0]?.permitido).toBe(true);
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 4, bloqueado: false });
    // Quien controla el correo restablece (aun no hay bloqueo vigente: 0080 lo borra) y vuelve a entrar a `pendiente`.
    const nuevo = hashFalso();
    expect(await exito(llamar(app, CONSUMIR, [await esc.tokenRecuperacion(u.id), nuevo]))).toHaveLength(1);
    const tok = nuevoToken();
    await exito(llamar(app, SQL.loginExito7, [esc.clave(u.correo), u.id, nuevo, tok, null, null, null]));
    await exito(llamar(app, SQL.reservar, [tok])); // 5.º codigo en la misma ventana de 15 min
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 5, bloqueado: true });
  });

  it("contrasena_cambiar no levanta un bloqueo vigente de codigos (como ya no lo hacen recuperacion_consumir ni login_exito)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    const v = await esc.sesionF(u.id, { factor: "verificado", tenant: A() });
    for (let i = 0; i < 5; i++) await exito(llamar(app, SQL.reservar, [v.token])); // 5 codigos erroneos al regenerar/desactivar
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 5, bloqueado: true });
    const nueva = nuevoToken();
    const r = await exito(llamar(app, "select auth.contrasena_cambiar($1::bytea, $2::text, $3::bytea) as c", [v.token, hashFalso(), nueva]));
    expect(r[0]?.c).toBe(u.correo);
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 5, bloqueado: true });
    expect((await exito(llamar(app, SQL.reservar, [nueva])))[0]?.permitido).toBe(false);
  });
});

describe("T15 · sesiones que se escriben sin el bloqueo `auth.totp:<usuario>` (U3, U5)", () => {
  it("U3: una rotacion (cambio de estudio) en curso cuando se confirma el TOTP no deja viva una sesion `sin_factor`", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpPendiente(u.id);
    const s1 = await esc.sesionF(u.id, { factor: "sin_factor", tenant: A() });
    const s2 = await esc.sesionF(u.id, { factor: "sin_factor", tenant: A() });
    const rot = await retener(ROTAR, [s2.token, nuevoToken(), A()]);
    let conf: Promise<any[]> | undefined;
    try {
      expect(rot.filas).toHaveLength(1);
      conf = exito(llamar(app, SQL.confirmar, [s1.token, String(PASO), diez(), nuevoToken()]));
      await esperarBloqueo("auth.totp_confirmar");
      await rot.fin(true);
    } catch (e) {
      await rot.fin(false);
      throw e;
    }
    expect(await conf).toHaveLength(1);
    expect((await esc.filaTotp(u.id))!.activo_cifrado).not.toBeNull();
    const vivas = (await esc.sesionesDe(u.id)).filter((f) => f.revocada_en === null && f.factor !== "verificado");
    expect(vivas.map((f) => f.factor)).toEqual([]);
  });

  it("U5: totp_restablecer con una rotacion en curso no deja viva ninguna sesion del usuario", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    const s = await esc.sesionF(u.id, { factor: "verificado", tenant: A() });
    const rot = await retener(ROTAR, [s.token, nuevoToken(), A()]);
    let res: Promise<any[]> | undefined;
    try {
      expect(rot.filas).toHaveLength(1);
      res = exito(llamar(admin, SQL.restablecer, [u.correo], "contapp_migrator"));
      await esperarBloqueo("auth.totp_restablecer");
      await rot.fin(true);
    } catch (e) {
      await rot.fin(false);
      throw e;
    }
    expect(await res).toHaveLength(1);
    expect(await esc.filaTotp(u.id)).toBeUndefined();
    const vivas = (await esc.sesionesDe(u.id)).filter((f) => f.revocada_en === null);
    expect(vivas.map((f) => f.factor)).toEqual([]);
  });

  it("CA-1: un re-enrolamiento entre la evaluacion del codigo y totp_confirmar no activa un secreto que nadie verifico", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const s1 = await esc.sesionF(u.id, { factor: "sin_factor", tenant: A() });
    const p1 = randomBytes(48);
    await exito(llamar(app, SQL.enrolarIniciar, [u.id, p1, 1]));
    // El backend leyo P1 y evaluo el codigo contra P1; en ese intervalo otra sesion (u otra pestana) enrola P2.
    const p2 = randomBytes(48);
    await exito(llamar(app, SQL.enrolarIniciar, [u.id, p2, 1]));
    const r = await exito(llamar(app, SQL.confirmar, [s1.token, String(PASO), diez(), nuevoToken()]));
    const activo = (await esc.filaTotp(u.id))!.activo_cifrado as Buffer | null;
    expect(r.length === 0 || (activo !== null && activo.equals(p1)), "se activo P2, cuyo codigo nunca se evaluo").toBe(true);
  });

  it("login_exito (revoca la cookie anterior) y totp_intento_reservar con esa misma sesion no se interbloquean", async () => {
    const errores: string[] = [];
    for (let i = 0; i < 6; i++) {
      const u = await esc.usuario({ estudios: [A()] });
      await esc.totpActivo(u.id);
      const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
      const [l, r] = await Promise.all([
        llamar(app, SQL.loginExito7, [esc.clave(u.correo), u.id, u.hash, nuevoToken(), null, null, p.token]),
        llamar(app, SQL.reservar, [p.token]),
      ]);
      for (const x of [l, r]) if (!x.ok) errores.push(String(x.code));
    }
    expect(errores).toEqual([]);
  });
});

describe("T15 · funciones heredadas con `pendiente` (CA-2, 0080)", () => {
  it("ultimo_estudio, plataforma_yo y sesiones_cerrar_todas no sirven a una `pendiente` aunque el usuario tenga otras sesiones con estudio", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.adminPlataforma(u.id);
    await esc.totpActivo(u.id);
    const v = await esc.sesionF(u.id, { factor: "verificado", tenant: A() });
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    const ultimo = await exito(llamar(app, "select auth.ultimo_estudio($1::bytea) as t", [p.token]));
    const yo = await exito(llamar(app, "select * from auth.plataforma_yo($1::bytea)", [p.token]));
    const n = await exito(llamar(app, "select auth.sesiones_cerrar_todas($1::bytea) as n", [p.token]));
    const ultimoV = await exito(llamar(app, "select auth.ultimo_estudio($1::bytea) as t", [v.token]));
    expect({ ultimo: ultimo[0].t, yo: yo.length, n: Number(n[0].n), ultimoV: ultimoV[0].t }).toEqual({
      ultimo: null,
      yo: 0,
      n: 0,
      ultimoV: A(),
    });
    expect(await exito(llamar(app, SQL.validar, [v.token]))).toHaveLength(1);
  });
});
