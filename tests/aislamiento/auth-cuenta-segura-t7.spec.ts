// Spec 029 (T7) · migracion 0079_cuenta_segura_t7: el contador de 004 D7 solo guarda los intentos fallidos (login con TOTP e
// `auth.intento_acierto`) y el cambio de contrasena conserva el factor de la sesion. Caso feliz y de error por comportamiento. El catalogo
// (dueño, SECURITY DEFINER, EXECUTE solo contapp_backend) lo cubren FUNCIONES_AUTH en auth.spec.ts, escalada.adv.spec.ts y auth-r2a.adv.spec.ts.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFalso } from "./auth-soporte";
import { EscenarioTotp, abrirAdmin, abrirApp, exito, llamar, nuevoToken, tenantDe } from "./auth-totp-soporte";

let app: Pool;
let admin: Pool;
let esc: EscenarioTotp;
beforeAll(() => {
  app = abrirApp(6);
  admin = abrirAdmin(4);
  esc = new EscenarioTotp(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});
const A = () => tenantDe("A");

const SQL = {
  loginExito:
    "select * from auth.login_exito($1::bytea, $2::uuid, $3::text, $4::bytea, $5::uuid, $6::text, $7::bytea, $8::text, $9::text, $10::cidr)",
  acierto: "select auth.intento_acierto($1::bytea) as r",
  cambiar: "select auth.contrasena_cambiar($1::bytea, $2::text, $3::bytea) as v",
} as const;

async function bloquear(correo: string, fallos: number): Promise<void> {
  await esc.sembrarFallos(correo, fallos);
  await admin.query("update auth.intento_login set bloqueado_hasta = now() + interval '15 minutes' where clave = $1", [esc.clave(correo)]);
}

describe("0079 · auth.login_exito con TOTP activo descuenta su propia reserva", () => {
  it("con 3 (2 fallos previos + la reserva de este login) deja 2: no reinicia los fallos ni cuenta el acierto; la sesion nace pendiente", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    await esc.sembrarFallos(u.correo, 3);
    const t = nuevoToken();
    await exito(llamar(app, SQL.loginExito, [esc.clave(u.correo), u.id, u.hash, t, A(), null, null, "sin_factor", null, null]));
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 2, bloqueado: false });
    expect(await esc.filaSesion(t)).toMatchObject({ factor: "pendiente", tenant_activo: null });
  });

  it("si su reserva fue la 5.ª, el bloqueo se levanta (quedan 4); con la credencial cambiada no hay sesion ni descuento", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    await bloquear(u.correo, 5);
    await exito(llamar(app, SQL.loginExito, [esc.clave(u.correo), u.id, u.hash, nuevoToken(), A(), null, null, "sin_factor", null, null]));
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 4, bloqueado: false });
    const otro = nuevoToken();
    const r = await exito(llamar(app, SQL.loginExito, [esc.clave(u.correo), u.id, hashFalso(), otro, A(), null, null, "sin_factor", null, null]));
    expect(r).toEqual([]);
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 4, bloqueado: false });
    expect(await esc.filaSesion(otro)).toBeUndefined();
  });
});

describe("0079 · auth.intento_acierto", () => {
  it("con una sesion vigente `verificado` o `sin_factor` descuenta uno (nunca baja de 0) y levanta el bloqueo si quedan menos de 5", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const v = await esc.sesionF(u.id, { factor: "verificado", tenant: A() });
    const s = await esc.sesionF(u.id, { factor: "sin_factor" });
    await bloquear(u.correo, 5);
    await exito(llamar(app, SQL.acierto, [v.token]));
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 4, bloqueado: false });
    await exito(llamar(app, SQL.acierto, [s.token]));
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 3, bloqueado: false });
    await esc.sembrarFallos(u.correo, 0);
    await exito(llamar(app, SQL.acierto, [v.token]));
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 0, bloqueado: false });
  });

  it("con una sesion `pendiente`, revocada, vencida o desconocida no toca el contador", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    const vencida = await esc.sesionF(u.id, { factor: "verificado", expiraEn: "-1 second" });
    const revocada = await esc.sesionF(u.id, { factor: "verificado" });
    await admin.query("update auth.sesion set revocada_en = now() where id = $1", [revocada.id]);
    await esc.sembrarFallos(u.correo, 3);
    for (const t of [p.token, vencida.token, revocada.token, nuevoToken()]) await exito(llamar(app, SQL.acierto, [t]));
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 3, bloqueado: false });
  });
});

describe("0079 · auth.contrasena_cambiar conserva el factor de la sesion", () => {
  it("una sesion `verificado` rota a otra `verificado` con su dispositivo, red, estudio y caducidad; las demas se revocan", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    const s = await esc.sesionF(u.id, { factor: "verificado", tenant: A(), dispositivo: "Firefox en Linux", ipRed: "198.51.100.0/24" });
    const otra = await esc.sesionF(u.id, { factor: "verificado" });
    const nuevo = nuevoToken();
    const [f] = await exito(llamar(app, SQL.cambiar, [s.token, hashFalso(), nuevo]));
    expect(f.v).toBe(u.correo);
    const vieja = await esc.filaSesion(s.token);
    expect(await esc.filaSesion(nuevo)).toMatchObject({
      factor: "verificado",
      dispositivo: "Firefox en Linux",
      ip_red: "198.51.100.0/24",
      tenant_activo: A(),
      revocada_en: null,
      expira_absoluta: vieja!.expira_absoluta,
    });
    expect(vieja).toMatchObject({ motivo: "rotacion" });
    expect(await esc.filaSesion(otra.token)).toMatchObject({ motivo: "contrasena" });
  });

  it("una sesion `pendiente` no cambia la contrasena: NULL, sin sesion nueva y la credencial sigue igual", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    const nuevo = nuevoToken();
    const [f] = await exito(llamar(app, SQL.cambiar, [p.token, hashFalso(), nuevo]));
    expect(f.v).toBeNull();
    expect(await esc.filaSesion(nuevo)).toBeUndefined();
    expect((await esc.filaSesion(p.token))!.revocada_en).toBeNull();
    const [c] = (await admin.query("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id])).rows;
    expect(c.hash).toBe(u.hash);
  });
});
