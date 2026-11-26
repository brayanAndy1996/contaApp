/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 028 · T15 (ronda adversarial 1, adversario · opus). Baja pública y preferencias por HTTP con PG real: token reutilizado tras
// reactivar, límite por IP compartido por el servidor del proveedor de correo (RFC 8058), CSRF de la variante JSON (la ruta entera
// está fuera de `OrigenGuard`) y miembro desactivado con sesión viva. Solo pruebas: cada fallo es un hallazgo H-028-1-n (tasks.md, T15).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio, type RolSistema } from "../../../test/soporte-acceso.js";
import { filasPreferencia, prefs, sembrarToken, type TipoCorreo } from "../../../test/soporte-correo.js";
import { ipUnica, type Peticion, type Resp } from "../../../test/soporte.js";

let b: Banco;
let E: Estudio;
const ipsUsadas: string[] = [];

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
});
afterAll(async () => {
  if (b && ipsUsadas.length > 0)
    await b.sql("delete from auth.limite_tasa where sujeto = any($1::text[])", [ipsUsadas]).catch(() => undefined);
  await b?.cerrar();
});

const sql = <T = any>(t: string, v?: unknown[]) => b.sql<T>(t, v);
const ip = (): string => {
  const x = ipUnica();
  ipsUsadas.push(x);
  return x;
};
const baja = (token: unknown, extra: Partial<Peticion> = {}): Promise<Resp> =>
  b.h.pedir({ metodo: "POST", ruta: "/correo/baja", cuerpo: { token }, ...extra });
/** POST de RFC 8058 que hace el servidor del proveedor de correo (sin Origin ni cookies) a la URL de `List-Unsubscribe`. */
const unClic = (token: string, extra: Partial<Peticion> = {}): Promise<Resp> =>
  b.h.pedir({
    metodo: "POST",
    ruta: `/correo/baja?t=${token}`,
    cuerpo: "List-Unsubscribe=One-Click",
    cabeceras: { "Content-Type": "application/x-www-form-urlencoded" },
    origen: null,
    ...extra,
  });
const efectiva = async (u: Actor, tipo: TipoCorreo = "buzon_critico"): Promise<boolean> =>
  (await sql("select correo_preferencia_efectiva($1::uuid, $2::uuid, $3::text) as v", [u.tenantId, u.id, tipo]))[0].v;
const usuario = (rol: RolSistema = "contador", sesion = false): Promise<Actor> => b.miembro(E.tenantId, rol, { sesion });
const token = (u: Actor, tipo: TipoCorreo = "buzon_critico") => sembrarToken(sql, { tenantId: u.tenantId, usuarioId: u.id, tipo });

describe("T15 · baja: reutilización del token", () => {
  it("H-028-1-5: el enlace ya usado no vuelve a apagar el tipo que el usuario reactivó después en la app", async () => {
    const u = await usuario("contador", true);
    const t = await token(u);
    expect((await baja(t.token, { ip: ip() })).status).toBe(200);
    expect(await efectiva(u)).toBe(false);
    // El usuario se arrepiente y lo reactiva en «Mi cuenta → Correo».
    expect((await b.llamar(u, "PUT", "/cuenta/correo", prefs("contador", { buzonCritico: true }))).status).toBe(200);
    expect(await efectiva(u)).toBe(true);
    // El mismo correo (reenviado, en un buzón compartido o abierto por un escáner que hace el POST de RFC 8058) vuelve a apagarlo.
    expect((await unClic(t.token, { ip: ip() })).status).toBe(200);
    expect(await efectiva(u), "un token de 90 días sigue apagando lo que el usuario reactivó (no es de un solo uso)").toBe(true);
  });
});

describe("T15 · baja: límite por IP del POST de RFC 8058", () => {
  it("H-028-1-6: 25 usuarios distintos que pulsan «Cancelar suscripción» en el mismo proveedor (misma IP de salida) quedan todos de baja", async () => {
    const proveedor = ip(); // el POST de RFC 8058 lo hace el servidor del proveedor de correo, no el navegador del usuario
    const usuarios: Actor[] = [];
    const estados: number[] = [];
    for (let i = 0; i < 25; i++) {
      const u = await usuario();
      usuarios.push(u);
      const t = await token(u);
      estados.push((await unClic(t.token, { ip: proveedor })).status);
    }
    const apagados = await Promise.all(usuarios.map((u) => efectiva(u).then((v) => !v)));
    expect(
      { estados: [...new Set(estados)], apagados: apagados.filter(Boolean).length },
      "a partir del 21.º en 10 min el proveedor recibe 429 y el usuario sigue recibiendo el tipo (el cliente de correo no reintenta)",
    ).toEqual({ estados: [200], apagados: 25 });
  }, 120_000);
});

describe("T15 · baja: CSRF en la variante JSON (OrigenGuard exento en toda la ruta)", () => {
  it("H-028-1-7: el POST JSON del botón de /baja desde un origen ajeno (Sec-Fetch-Site: cross-site) se rechaza y no apaga nada", async () => {
    const u = await usuario();
    const t = await token(u);
    const r = await baja(t.token, { ip: ip(), origen: "https://atacante.example", secFetchSite: "cross-site" });
    const resultado = { estado: r.status, apagado: !(await efectiva(u)) };
    // Control: desde el propio origen sí apaga.
    const u2 = await usuario();
    const t2 = await token(u2);
    expect((await baja(t2.token, { ip: ip() })).status).toBe(200);
    expect(await efectiva(u2)).toBe(false);
    expect(
      resultado,
      "la variante de la página no necesita quedar fuera de OrigenGuard: solo la de RFC 8058 viene sin Origin",
    ).toEqual({ estado: 403, apagado: false });
  });
});

describe("T15 · preferencias: miembro desactivado con sesión viva", () => {
  it("tras desactivarlo, su sesión no lee ni cambia sus preferencias del estudio (ni crea filas ni audita)", async () => {
    const u = await usuario("contador", true);
    expect((await b.llamar(u, "GET", "/cuenta/correo")).status).toBe(200);
    expect((await b.llamar(E.titular, "POST", `/usuarios/${u.id}/desactivar`)).status).toBe(200);
    const g = await b.llamar(u, "GET", "/cuenta/correo");
    const p = await b.llamar(u, "PUT", "/cuenta/correo", prefs("contador", { buzonCritico: false, resumen: true }));
    expect(g.status).toBeGreaterThanOrEqual(400);
    expect(p.status).toBeGreaterThanOrEqual(400);
    expect(await filasPreferencia(sql, E.tenantId, u.id)).toEqual([]);
    expect(
      await sql("select 1 from auditoria where tenant_id = $1 and usuario_id = $2 and accion = 'correo.preferencia_cambiada'", [
        E.tenantId,
        u.id,
      ]),
    ).toEqual([]);
  });
});
