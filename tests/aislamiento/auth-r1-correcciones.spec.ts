// Spec 004 · T16: correcciones de la ronda adversarial 1 en la BD (migración 0008_auth_ronda1).
//   H1      contrasena_cambiar invalida los tokens de recuperación vivos del usuario.
//   H-r1b-1 limite_consumir('restab_ip') = 10 cada 15 min; recuperacion_vigente(token) sin efectos.
//   H-r1b-2 contrasena_cambiar reinicia el contador de intentos (CA-3).
//   H-r1b-4 usuario.email solo ASCII (decisión del usuario).
// Usa el Escenario de auth-soporte (filas propias, borradas al final); la prueba de CHECK va en ROLLBACK.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Escenario, abrirAdmin, abrirApp, exito, hashFalso, llamar, nuevoToken, tenantDe } from "./auth-soporte";

let app: Pool;
let admin: Pool;
let esc: Escenario;

beforeAll(() => {
  app = abrirApp(4);
  admin = abrirAdmin(4);
  esc = new Escenario(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});

const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
const escalar = async (sql: string, v: unknown[] = []) => (await exito(llamar(app, sql, v)))[0]?.v;
const limite = (tipo: string, sujeto: string) =>
  escalar("select auth.limite_consumir($1::text, $2::text) as v", [tipo, sujeto]) as Promise<boolean>;
const vigente = (t: Buffer) => escalar("select auth.recuperacion_vigente($1::bytea) as v", [t]) as Promise<boolean>;
const cambiar = (t: Buffer, nuevo: Buffer) =>
  exito(llamar(app, "select auth.contrasena_cambiar($1::bytea, $2::text, $3::bytea) as v", [t, hashFalso(), nuevo]));
const consumir = (t: Buffer) =>
  exito(llamar(app, "select usuario_id from auth.recuperacion_consumir($1::bytea, $2::text)", [t, hashFalso()]));

describe("auth.limite_consumir('restab_ip') (H-r1b-1)", () => {
  it("admite 10 consumos por sujeto y rechaza el 11.º", async () => {
    const s = esc.sujeto("restab_ip");
    for (let i = 1; i <= 10; i++) expect(await limite("restab_ip", s), `consumo ${i}`).toBe(true);
    expect(await limite("restab_ip", s)).toBe(false);
  });

  it("la ventana dura 15 min: a los 16 reinicia, a los 14 sigue llena", async () => {
    const s = esc.sujeto("restab_ip");
    for (let i = 0; i < 11; i++) await limite("restab_ip", s);
    await adm("update auth.limite_tasa set ventana_inicio = now() - interval '14 minutes' where tipo = 'restab_ip' and sujeto = $1", [s]);
    expect(await limite("restab_ip", s)).toBe(false);
    await adm("update auth.limite_tasa set ventana_inicio = now() - interval '16 minutes' where tipo = 'restab_ip' and sujeto = $1", [s]);
    expect(await limite("restab_ip", s)).toBe(true);
  });
});

describe("auth.recuperacion_vigente (H-r1b-1)", () => {
  it("true con un token vivo, sin consumirlo; false con uno desconocido, usado, invalidado o vencido", async () => {
    const u = await esc.usuario();
    const vivo = await esc.tokenRecuperacion(u.id);
    expect(await vigente(vivo)).toBe(true);
    expect(await vigente(vivo)).toBe(true); // sin efectos
    const [f] = await adm("select usado_en, invalidado_en from auth.token_recuperacion where token_hash = $1", [vivo]);
    expect(f).toEqual({ usado_en: null, invalidado_en: null });

    expect(await vigente(nuevoToken())).toBe(false);
    const usado = await esc.tokenRecuperacion(u.id);
    expect(await consumir(usado)).toHaveLength(1);
    expect(await vigente(usado)).toBe(false);
    expect(await vigente(vivo)).toBe(false); // consumir invalidó los demás
    const vencido = await esc.tokenRecuperacion(u.id);
    await adm("update auth.token_recuperacion set expira_en = now() - interval '1 second' where token_hash = $1", [vencido]);
    expect(await vigente(vencido)).toBe(false);
  });
});

describe("auth.contrasena_cambiar tras la ronda 1 (H1, H-r1b-2)", () => {
  it("invalida los tokens de recuperación vivos del usuario (no los de otros) y reinicia su contador de intentos", async () => {
    const u = await esc.usuario({ estudios: [tenantDe("A")] });
    const otro = await esc.usuario();
    const tU = await esc.tokenRecuperacion(u.id);
    const tOtro = await esc.tokenRecuperacion(otro.id);
    const k = esc.clave(u.correo);
    await adm("insert into auth.intento_login (clave, fallos, ventana_inicio) values ($1, 4, now())", [k]);

    const s = await esc.sesion(u.id, tenantDe("A"));
    const r = await cambiar(s, nuevoToken());
    expect(r[0].v).toBe(u.correo);

    expect(await vigente(tU)).toBe(false);
    const [f] = await adm("select invalidado_en is not null as inv from auth.token_recuperacion where token_hash = $1", [tU]);
    expect(f.inv).toBe(true);
    expect(await vigente(tOtro)).toBe(true);
    expect(await consumir(tU)).toHaveLength(0);
    const [i] = await adm("select fallos, bloqueado_hasta from auth.intento_login where clave = $1", [k]);
    expect(i).toEqual({ fallos: 0, bloqueado_hasta: null });
  });

  it("con una sesión inválida no invalida tokens ni toca el contador", async () => {
    const u = await esc.usuario();
    const t = await esc.tokenRecuperacion(u.id);
    const k = esc.clave(u.correo);
    await adm("insert into auth.intento_login (clave, fallos, ventana_inicio) values ($1, 3, now())", [k]);
    const r = await cambiar(nuevoToken(), nuevoToken());
    expect(r[0]?.v ?? null).toBeNull();
    expect(await vigente(t)).toBe(true);
    expect((await adm("select fallos from auth.intento_login where clave = $1", [k]))[0].fallos).toBe(3);
  });
});

describe("usuario.email solo ASCII (H-r1b-4, decisión del usuario)", () => {
  it("acepta ASCII (incluido punycode) y rechaza con 23514 cualquier carácter no ASCII", async () => {
    const c = await admin.connect();
    const sufijo = () => `${randomBytes(5).toString("hex")}@t004.contapp.test`;
    const insertar = async (email: string) => {
      await c.query("SAVEPOINT p");
      try {
        await c.query("insert into usuario (email, nombre) values ($1, 'T16')", [email]);
        await c.query("RELEASE SAVEPOINT p");
        return "ok";
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT p");
        return String((e as { code?: string }).code);
      }
    };
    try {
      await c.query("BEGIN");
      expect(await insertar(`ascii-${sufijo()}`)).toBe("ok");
      expect(await insertar(`ana-${randomBytes(4).toString("hex")}@xn--estudio-zwa.pe`)).toBe("ok");
      for (const email of [`straße-${sufijo()}`, `café-${sufijo()}`, `ana-${randomBytes(4).toString("hex")}@estudiño.pe`]) {
        expect(await insertar(email), "no ASCII").toBe("23514");
      }
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});
