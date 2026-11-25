/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T3 (029) · CA-5 (lista y revocación de sesiones, RF-014), U6 (dispositivo e IP truncada) y CSRF/Origen/no-store de las rutas nuevas.
// Rojo: `GET /auth/sesiones`, `POST /auth/sesiones/:id/revocar` y `/revocar-otras` y las columnas `dispositivo`/`ip_red` aún no existen (T5, T7).
import { sesionesCuentaRespuestaSchema } from "@contapp/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forma, seedAuth, type Harness } from "../../../test/soporte.js";
import { abrirHarnessTotp, entrarSinTotp, sesionesDe, visible, type SesionTotp } from "../../../test/soporte-totp.js";

let h: Harness;
beforeAll(async () => {
  h = await abrirHarnessTotp();
});
afterAll(async () => {
  await h?.cerrar();
});

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const lista = (s: { cookie: string }, extra: Record<string, unknown> = {}) => h.pedir({ ruta: "/auth/sesiones", cookie: s.cookie, ...extra });
const revocar = (s: { cookie: string; csrf: string }, id: string, extra: Record<string, unknown> = {}) =>
  h.pedir({ ruta: `/auth/sesiones/${id}/revocar`, cuerpo: {}, cookie: s.cookie, csrf: s.csrf, ...extra });
const revocarOtras = (s: { cookie: string; csrf: string }, extra: Record<string, unknown> = {}) =>
  h.pedir({ ruta: "/auth/sesiones/revocar-otras", cuerpo: {}, cookie: s.cookie, csrf: s.csrf, ...extra });
const viva = async (s: { cookie: string }) => (await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).status === 200;

/** Varias sesiones del mismo usuario; devuelve cada una con su id (de la lista de la última). */
async function sesiones(n: number, estudios: string[] = []): Promise<{ u: { id: string; correo: string; contrasena: string }; ss: SesionTotp[] }> {
  const u = await h.crearUsuario({ estudios });
  const ss: SesionTotp[] = [];
  for (let i = 0; i < n; i++) ss.push(await entrarSinTotp(h, u));
  return { u, ss };
}

describe("CA-5 · GET /auth/sesiones: solo las propias vigentes, sin hashes ni tokens", () => {
  it("devuelve [{id, creadaEn, ultimoUso, dispositivo, ip, actual}] y marca solo la sesión que pregunta", async () => {
    const { ss } = await sesiones(3);
    const r = await lista(ss[1]!);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toHaveLength(3);
    expect(sesionesCuentaRespuestaSchema.safeParse(r.body).success).toBe(true);
    for (const f of r.body) expect(Object.keys(f).sort()).toEqual(["actual", "creadaEn", "dispositivo", "id", "ip", "ultimoUso"]);
    expect(r.body.filter((f: any) => f.actual)).toHaveLength(1);
    // Ninguna fuga: ni tokens ni sus hashes ni el CSRF.
    for (const s of ss) {
      expect(r.text).not.toContain(s.valor);
      expect(r.text).not.toContain(s.csrf);
    }
    expect(r.text).not.toMatch(/token|hash|csrf/i);
  });

  it("la 'actual' cambia según quién pregunta, y todas las sesiones propias aparecen", async () => {
    const { ss } = await sesiones(2);
    const a = await lista(ss[0]!);
    const b = await lista(ss[1]!);
    expect(a.body.find((f: any) => f.actual).id).not.toBe(b.body.find((f: any) => f.actual).id);
    expect(a.body.map((f: any) => f.id).sort()).toEqual(b.body.map((f: any) => f.id).sort());
  });

  it("no lista las ajenas, las revocadas ni las vencidas (absoluta o por inactividad)", async () => {
    const { u, ss } = await sesiones(4);
    const ajena = await sesiones(1);
    const filas = await sesionesDe(h, u.id);
    await h.sql("update auth.sesion set expira_absoluta = now() - interval '1 minute' where id = $1", [filas[1].id]);
    await h.sql("update auth.sesion set ultimo_uso = now() - interval '125 minutes' where id = $1", [filas[2].id]);
    await revocar(ss[3]!, filas[0].id);
    const r = await lista(ss[3]!);
    expect(r.body.map((f: any) => f.id)).toEqual([filas[3].id]);
    expect(r.text).not.toContain(ajena.ss[0]!.valor);
    expect((await sesionesDe(h, ajena.u.id)).map((f) => f.id).some((id) => r.body.some((f: any) => f.id === id))).toBe(false);
  });

  it("sin sesión da 401 sesion_invalida y un GET no cambia ninguna sesión", async () => {
    const { u, ss } = await sesiones(2);
    const antes = (await sesionesDe(h, u.id)).map((f) => [f.id, f.revocada_en, f.factor]);
    const anon = await h.pedir({ ruta: "/auth/sesiones" });
    expect(anon.status).toBe(401);
    expect(anon.body).toEqual({ codigo: "sesion_invalida" });
    await lista(ss[0]!);
    await lista(ss[0]!, { origen: "https://evil.example" });
    expect((await sesionesDe(h, u.id)).map((f) => [f.id, f.revocada_en, f.factor])).toEqual(antes);
  });
});

describe("U6 · dispositivo resumido e IP truncada", () => {
  it("el dispositivo sale de una lista cerrada (navegador y SO) y nunca guarda el User-Agent; el UA raro es «Otro»", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const chrome = await entrarSinTotp(h, u);
    const login = await h.login(u.correo, u.contrasena, { cabeceras: { "User-Agent": CHROME_WIN } });
    expect(login.status).toBe(200);
    const raro = await h.login(u.correo, u.contrasena, { cabeceras: { "User-Agent": "canario-ua/9.9 (<script>)" } });
    expect(raro.status).toBe(200);
    const r = await lista(chrome);
    const disp: string[] = r.body.map((f: any) => f.dispositivo);
    expect(disp.some((d) => /Chrome/.test(d) && /Windows/.test(d))).toBe(true);
    expect(disp.some((d) => /Otro/.test(d))).toBe(true);
    for (const d of disp) {
      expect(d.length).toBeLessThanOrEqual(60);
      expect(d).not.toMatch(/Mozilla|AppleWebKit|canario|script/);
    }
    for (const f of await sesionesDe(h, u.id)) {
      expect(String(f.dispositivo).length).toBeLessThanOrEqual(60);
      expect(String(f.dispositivo)).not.toMatch(/Mozilla|AppleWebKit|canario|script/);
    }
  });

  it("una IPv4 se guarda y se muestra como /24 y una IPv6 como /48; la IP completa no aparece en BD ni en la respuesta", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s4 = await h.login(u.correo, u.contrasena, { ip: "203.0.113.77" });
    const s6 = await h.login(u.correo, u.contrasena, { ip: "2001:db8:abcd:12:aaaa:bbbb:cccc:dddd" });
    expect(s4.status).toBe(200);
    expect(s6.status).toBe(200);
    const filas = await sesionesDe(h, u.id);
    const redes = filas.map((f) => String(f.ip_red));
    expect(redes).toContain("203.0.113.0/24");
    expect(redes.some((x) => /^2001:db8:abcd::\/48$/.test(x))).toBe(true);
    const sesion = await entrarSinTotp(h, u);
    const r = await lista(sesion);
    expect(r.text).not.toMatch(/203\.0\.113\.77|aaaa:bbbb|cccc:dddd/);
    expect(r.body.some((f: any) => String(f.ip).startsWith("203.0.113.0"))).toBe(true);
    expect(await h.sql("select count(*)::int as n from auth.sesion where usuario_id = $1 and masklen(ip_red) not in (24, 48)", [u.id])).toEqual([{ n: 0 }]);
  });
});

describe("CA-5 · revocar una sesión propia", () => {
  it("204: la revocada da 401 en su siguiente petición, la otra sigue y el motivo queda revocada_usuario", async () => {
    const { u, ss } = await sesiones(2);
    const id = (await lista(ss[0]!)).body.find((f: any) => !f.actual).id;
    const r = await revocar(ss[0]!, id);
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await viva(ss[1]!)).toBe(false);
    expect(await viva(ss[0]!)).toBe(true);
    const f = (await sesionesDe(h, u.id)).find((x) => x.id === id);
    expect(f.motivo).toBe("revocada_usuario");
    expect(f.revocada_en).not.toBeNull();
    expect((await lista(ss[0]!)).body.map((x: any) => x.id)).not.toContain(id);
  });

  it("un id ajeno, inexistente o ya revocado responde igual (204) y no toca la sesión ajena", async () => {
    const { u, ss } = await sesiones(2);
    const ajeno = await sesiones(1);
    const idAjeno = (await sesionesDe(h, ajeno.u.id))[0].id;
    const idPropio = (await lista(ss[0]!)).body.find((f: any) => !f.actual).id;
    expect((await revocar(ss[0]!, idPropio)).status).toBe(204);
    const base = await revocar(ss[0]!, randomUUID());
    const rs = [base, await revocar(ss[0]!, idAjeno), await revocar(ss[0]!, idPropio), await revocar(ss[0]!, idPropio)];
    for (const r of rs) {
      expect(r.status).toBe(204);
      expect(forma(r)).toEqual(forma(base));
    }
    expect(await viva(ajeno.ss[0]!)).toBe(true);
    expect((await sesionesDe(h, ajeno.u.id))[0].revocada_en).toBeNull();
    expect((await sesionesDe(h, u.id)).filter((f) => f.revocada_en === null)).toHaveLength(1);
  });

  it("un id mal formado no da 5xx ni revela nada (204 o 400, sin eco)", async () => {
    const { ss } = await sesiones(1);
    for (const id of ["no-es-uuid", "canario-eco", "0", "%00", "'%20or%201=1"]) {
      const r = await revocar(ss[0]!, id);
      expect([204, 400, 404]).toContain(r.status);
      expect(visible(r)).not.toContain("canario-eco");
    }
    expect(await viva(ss[0]!)).toBe(true);
  });
});

describe("CA-5 · revocar todas menos la actual", () => {
  it("204: las demás caen con revocada_usuario, la actual sigue y las de otro usuario no se tocan", async () => {
    const { u, ss } = await sesiones(3);
    const ajeno = await sesiones(1);
    const r = await revocarOtras(ss[1]!);
    expect(r.status).toBe(204);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await viva(ss[0]!)).toBe(false);
    expect(await viva(ss[2]!)).toBe(false);
    expect(await viva(ss[1]!)).toBe(true);
    expect(await viva(ajeno.ss[0]!)).toBe(true);
    const filas = await sesionesDe(h, u.id);
    expect(filas.filter((f) => f.revocada_en !== null).every((f) => f.motivo === "revocada_usuario")).toBe(true);
    expect(filas.filter((f) => f.revocada_en === null)).toHaveLength(1);
    expect((await lista(ss[1]!)).body).toHaveLength(1);
  });

  it("sin otras sesiones sigue siendo 204 (idempotente)", async () => {
    const { ss } = await sesiones(1);
    expect((await revocarOtras(ss[0]!)).status).toBe(204);
    expect((await revocarOtras(ss[0]!)).status).toBe(204);
    expect(await viva(ss[0]!)).toBe(true);
  });
});

describe("CSRF, Origen y no-store de las rutas de sesiones", () => {
  it("sin CSRF 403 csrf_invalido, con Origin ajeno 403 origen_invalido, sin sesión 401: ninguna revoca", async () => {
    const { u, ss } = await sesiones(2);
    const id = (await lista(ss[0]!)).body.find((f: any) => !f.actual).id;
    const rutas = [`/auth/sesiones/${id}/revocar`, "/auth/sesiones/revocar-otras"];
    for (const ruta of rutas) {
      const sinCsrf = await h.pedir({ ruta, cuerpo: {}, cookie: ss[0]!.cookie });
      expect(sinCsrf.status, ruta).toBe(403);
      expect(sinCsrf.body).toEqual({ codigo: "csrf_invalido" });
      const otraSesion = await h.pedir({ ruta, cuerpo: {}, cookie: ss[0]!.cookie, csrf: ss[1]!.csrf });
      expect(otraSesion.status).toBe(403);
      const ajeno = await h.pedir({ ruta, cuerpo: {}, cookie: ss[0]!.cookie, csrf: ss[0]!.csrf, origen: "https://evil.example" });
      expect(ajeno.status).toBe(403);
      expect(ajeno.body).toEqual({ codigo: "origen_invalido" });
      const cross = await h.pedir({ ruta, cuerpo: {}, cookie: ss[0]!.cookie, csrf: ss[0]!.csrf, origen: null, secFetchSite: "cross-site" });
      expect(cross.status).toBe(403);
      expect((await h.pedir({ ruta, cuerpo: {} })).status).toBe(401);
    }
    expect((await sesionesDe(h, u.id)).filter((f) => f.revocada_en === null)).toHaveLength(2);
  });

  it("los GET sobre las rutas de acción no existen y no ejecutan nada (404 o 405)", async () => {
    const { ss } = await sesiones(2);
    for (const ruta of ["/auth/sesiones/revocar-otras", `/auth/sesiones/${randomUUID()}/revocar`, "/auth/totp/enrolar", "/auth/totp/confirmar", "/auth/totp/desactivar", "/auth/totp/recuperacion", "/auth/2fa/verificar"]) {
      const r = await h.pedir({ ruta, cookie: ss[0]!.cookie });
      expect([404, 405], ruta).toContain(r.status);
    }
    expect(await viva(ss[1]!)).toBe(true);
  });

  it("todas las respuestas de las rutas nuevas, también los errores, llevan Cache-Control: no-store", async () => {
    const { ss } = await sesiones(2);
    const id = (await lista(ss[0]!)).body.find((f: any) => !f.actual).id;
    const respuestas = [
      await lista(ss[0]!),
      await h.pedir({ ruta: "/auth/sesiones" }),
      await revocar(ss[0]!, id),
      await h.pedir({ ruta: `/auth/sesiones/${id}/revocar`, cuerpo: {}, cookie: ss[0]!.cookie }),
      await revocarOtras(ss[0]!),
      await h.pedir({ ruta: "/auth/totp/enrolar", cuerpo: { contrasena: "mala" }, cookie: ss[0]!.cookie, csrf: ss[0]!.csrf }),
      await h.pedir({ ruta: "/auth/totp/enrolar", cuerpo: {}, cookie: ss[0]!.cookie, csrf: ss[0]!.csrf }),
      await h.pedir({ ruta: "/auth/totp/confirmar", cuerpo: { codigo: "000000" }, cookie: ss[0]!.cookie, csrf: ss[0]!.csrf }),
      await h.pedir({ ruta: "/auth/totp/desactivar", cuerpo: { contrasena: "x", codigo: "000000" }, cookie: ss[0]!.cookie, csrf: ss[0]!.csrf }),
      await h.pedir({ ruta: "/auth/totp/recuperacion", cuerpo: { contrasena: "x", codigo: "000000" }, cookie: ss[0]!.cookie, csrf: ss[0]!.csrf }),
      await h.pedir({ ruta: "/auth/2fa/verificar", cuerpo: { codigo: "000000" }, cookie: ss[0]!.cookie, csrf: ss[0]!.csrf }),
    ];
    for (const r of respuestas) {
      expect(r.headers["cache-control"]).toMatch(/no-store/);
      expect(r.headers["x-powered-by"]).toBeUndefined();
    }
  });

  it("el cambio de estudio rota el token pero la lista sigue mostrando una sola sesión, la actual, con el mismo dispositivo", async () => {
    const u = await h.crearUsuario({ estudios: [seedAuth().tenantA, seedAuth().tenantB] });
    const s = await entrarSinTotp(h, u);
    const antes = (await lista(s)).body;
    expect(antes).toHaveLength(1);
    const el = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seedAuth().tenantA }, cookie: s.cookie, csrf: s.csrf });
    expect(el.status).toBe(200);
    const nueva = el.setCookies[0]!.split(";")[0]!;
    const despues = (await h.pedir({ ruta: "/auth/sesiones", cookie: nueva })).body;
    expect(despues).toHaveLength(1);
    expect(despues[0].actual).toBe(true);
    expect(despues[0].dispositivo).toBe(antes[0].dispositivo);
  });
});
