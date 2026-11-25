// Spec 029 (T1, rojo hasta 0078) · CA-5: listar, revocar una y revocar las otras. Contrato en `auth-totp-soporte.ts`.
// Rojo por: auth.sesiones_listar / sesion_revocar_id / sesiones_revocar_otras aun no existen (42883) y falta auth.sesion.factor.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioTotp, SQL, abrirAdmin, abrirApp, exito, llamar, nuevoToken, tenantDe } from "./auth-totp-soporte";

let app: Pool;
let admin: Pool;
let esc: EscenarioTotp;
beforeAll(() => {
  app = abrirApp(10);
  admin = abrirAdmin(4);
  esc = new EscenarioTotp(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});
const A = () => tenantDe("A");
const listar = (t: Buffer) => exito(llamar(app, SQL.listar, [t]));
const revocar = (t: Buffer, id: string) => llamar(app, SQL.revocarId, [t, id]);
const otras = async (t: Buffer) => Number((await exito(llamar(app, SQL.revocarOtras, [t])))[0].n);
const nuevoUsuario = () => esc.usuario({ estudios: [A()] });

describe("auth.sesiones_listar (CA-5)", () => {
  it("devuelve solo las vigentes del dueño, con las columnas del contrato, sin hashes ni tokens, y marca `actual`", async () => {
    const u = await nuevoUsuario();
    const actual = await esc.sesionF(u.id, { factor: "verificado", dispositivo: "Chrome en Windows", ipRed: "203.0.113.0/24", ultimoUsoHace: "1 minute" });
    const otra = await esc.sesionF(u.id, { factor: "sin_factor", dispositivo: "Safari en iOS", ipRed: "2001:db8:1234::/48", ultimoUsoHace: "30 minutes" });
    const r = await listar(actual.token);
    expect(r).toHaveLength(2);
    expect(Object.keys(r[0])).toEqual(["id", "creada_en", "ultimo_uso", "dispositivo", "ip_red", "actual"]);
    expect(JSON.stringify(r)).not.toContain(actual.token.toString("hex"));
    const ids = r.map((x) => x.id);
    expect(ids.sort()).toEqual([actual.id, otra.id].sort());
    expect(r.find((x) => x.id === actual.id)).toMatchObject({ actual: true, dispositivo: "Chrome en Windows", ip_red: "203.0.113.0/24" });
    expect(r.find((x) => x.id === otra.id)).toMatchObject({ actual: false, dispositivo: "Safari en iOS", ip_red: "2001:db8:1234::/48" });
  });

  it("ordena por ultimo uso, la mas reciente primero", async () => {
    const u = await nuevoUsuario();
    const vieja = await esc.sesionF(u.id, { ultimoUsoHace: "90 minutes" });
    const media = await esc.sesionF(u.id, { ultimoUsoHace: "30 minutes" });
    const nueva = await esc.sesionF(u.id, { ultimoUsoHace: "1 minute" });
    expect((await listar(nueva.token)).map((x) => x.id)).toEqual([nueva.id, media.id, vieja.id]);
  });

  it("no incluye revocadas, vencidas (12 h), inactivas (> 2 h) ni `pendiente`, ni las de otros usuarios", async () => {
    const u = await nuevoUsuario();
    const ok = await esc.sesionF(u.id, { factor: "verificado" });
    const rev = await esc.sesionF(u.id);
    await admin.query("update auth.sesion set revocada_en = now(), motivo = 'logout' where id = $1", [rev.id]);
    await esc.sesionF(u.id, { expiraEn: "-1 second" });
    await esc.sesionF(u.id, { ultimoUsoHace: "3 hours" });
    await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    await esc.sesionF((await nuevoUsuario()).id);
    expect((await listar(ok.token)).map((x) => x.id)).toEqual([ok.id]);
  });

  it("con un token `pendiente`, revocado, vencido o inexistente no devuelve nada (la lista no sirve sin segundo factor)", async () => {
    const u = await nuevoUsuario();
    await esc.sesionF(u.id, { factor: "verificado" });
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    expect(await listar(p.token)).toEqual([]);
    expect(await listar(nuevoToken())).toEqual([]);
    const rev = await esc.sesionF(u.id);
    await admin.query("update auth.sesion set revocada_en = now() where id = $1", [rev.id]);
    expect(await listar(rev.token)).toEqual([]);
  });

  it("no escribe: listar no renueva ultimo_uso de nada", async () => {
    const u = await nuevoUsuario();
    const s = await esc.sesionF(u.id, { ultimoUsoHace: "10 minutes" });
    const antes = await esc.filaSesion(s.token);
    await listar(s.token);
    expect((await esc.filaSesion(s.token))!.ultimo_uso.getTime()).toBe(antes!.ultimo_uso.getTime());
  });
});

describe("auth.sesion_revocar_id (CA-5): una ajena, inexistente o ya revocada da la misma salida", () => {
  it("revoca una propia vigente (motivo revocada_usuario) y su siguiente validacion da cero filas (401)", async () => {
    const u = await nuevoUsuario();
    const yo = await esc.sesionF(u.id, { factor: "verificado" });
    const otra = await esc.sesionF(u.id);
    expect((await revocar(yo.token, otra.id)).ok).toBe(true);
    expect(await esc.filaSesion(otra.token)).toMatchObject({ motivo: "revocada_usuario" });
    expect((await esc.filaSesion(otra.token))!.revocada_en).toBeInstanceOf(Date);
    expect(await exito(llamar(app, SQL.validar, [otra.token]))).toHaveLength(0);
    expect(await exito(llamar(app, SQL.consultar, [otra.token]))).toHaveLength(0);
    expect((await esc.filaSesion(yo.token))!.revocada_en).toBeNull();
  });

  it("ajena, inexistente, ya revocada y la de un `pendiente`: salida IDENTICA (una fila, valor nulo) y ningun efecto sobre lo ajeno", async () => {
    const u = await nuevoUsuario();
    const yo = await esc.sesionF(u.id, { factor: "verificado" });
    const ajenaU = await nuevoUsuario();
    const ajena = await esc.sesionF(ajenaU.id, { factor: "verificado" });
    const yaRev = await esc.sesionF(u.id);
    await admin.query("update auth.sesion set revocada_en = now(), motivo = 'logout' where id = $1", [yaRev.id]);
    const antesAjena = await esc.filaSesion(ajena.token);
    const antesYaRev = await esc.filaSesion(yaRev.token);

    const propia = await esc.sesionF(u.id);
    const salidaOk = await revocar(yo.token, propia.id);
    const salidas = [
      await revocar(yo.token, ajena.id),
      await revocar(yo.token, "01920000-0000-7000-8000-00000000dead"),
      await revocar(yo.token, yaRev.id),
      await revocar(nuevoToken(), propia.id), // token inexistente
    ];
    for (const s of salidas) expect(s).toEqual(salidaOk);
    expect(await esc.filaSesion(ajena.token)).toEqual(antesAjena);
    expect(await esc.filaSesion(yaRev.token)).toEqual(antesYaRev); // no cambia motivo ni fecha
  });

  it("con un token `pendiente` no revoca nada", async () => {
    const u = await nuevoUsuario();
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    const otra = await esc.sesionF(u.id);
    await revocar(p.token, otra.id);
    expect((await esc.filaSesion(otra.token))!.revocada_en).toBeNull();
  });
});

describe("auth.sesiones_revocar_otras (CA-5)", () => {
  it("revoca las demas vigentes del usuario (revocada_usuario), devuelve cuantas y no toca la actual, las revocadas ni las ajenas", async () => {
    const u = await nuevoUsuario();
    const yo = await esc.sesionF(u.id, { factor: "verificado" });
    const o1 = await esc.sesionF(u.id);
    const o2 = await esc.sesionF(u.id, { factor: "verificado" });
    const vieja = await esc.sesionF(u.id);
    await admin.query("update auth.sesion set revocada_en = now(), motivo = 'logout' where id = $1", [vieja.id]);
    const ajena = await esc.sesionF((await nuevoUsuario()).id);
    expect(await otras(yo.token)).toBe(2);
    for (const s of [o1, o2]) expect(await esc.filaSesion(s.token)).toMatchObject({ motivo: "revocada_usuario" });
    expect((await esc.filaSesion(yo.token))!.revocada_en).toBeNull();
    expect((await esc.filaSesion(vieja.token))!.motivo).toBe("logout");
    expect((await esc.filaSesion(ajena.token))!.revocada_en).toBeNull();
    expect(await otras(yo.token)).toBe(0); // idempotente
  });

  it("con un token `pendiente`, revocado o inexistente devuelve 0 y no revoca nada", async () => {
    const u = await nuevoUsuario();
    const otra = await esc.sesionF(u.id);
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    expect(await otras(p.token)).toBe(0);
    expect(await otras(nuevoToken())).toBe(0);
    expect((await esc.filaSesion(otra.token))!.revocada_en).toBeNull();
  });
});
