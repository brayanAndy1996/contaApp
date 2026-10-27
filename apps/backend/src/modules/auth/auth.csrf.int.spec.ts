// T7 (004) · CA-7 (CSRF, Origin y Sec-Fetch-Site, GET sin efectos). Rojo: `crearApp` aun no existe (T12).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  forma,
  ORIGEN,
  seedAuth,
  type Harness,
  type Peticion,
  type SesionPrueba,
  type UsuarioPrueba,
} from "../../../test/soporte.js";

let h: Harness;
let u: UsuarioPrueba;
let s: SesionPrueba;
beforeAll(async () => {
  h = await abrirHarness();
  u = await h.crearUsuario({ estudios: [seedAuth().tenantA, seedAuth().tenantB] });
  s = await h.entrar(u);
});
afterAll(async () => {
  await h?.cerrar();
});

/** Cambio de estudio hacia A: si la petición pasa, rota la sesión; si se rechaza, no debe tocar nada. */
const cambiar = (extra: Partial<Peticion>) =>
  h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seedAuth().tenantA }, cookie: s.cookie, csrf: s.csrf, ...extra });

const sigueIgual = async () => {
  const r = await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie });
  expect(r.status).toBe(200);
  expect(r.body.estudioActivo).toBeNull();
};

describe("CA-7 · token CSRF de la sesión (D6)", () => {
  it("sin X-CSRF-Token: 403 csrf_invalido y no cambia el estado", async () => {
    const r = await cambiar({ csrf: null });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "csrf_invalido" });
    await sigueIgual();
  });

  it("token CSRF de otra sesión: 403", async () => {
    const otra = await h.entrar(u);
    const r = await cambiar({ csrf: otra.csrf });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "csrf_invalido" });
    await sigueIgual();
  });

  it("token alterado, truncado, de otra longitud o con el token de sesión: 403 (sin error 500)", async () => {
    const alterado = `${s.csrf.slice(0, -1)}${s.csrf.endsWith("A") ? "B" : "A"}`;
    for (const malo of [alterado, s.csrf.slice(0, 10), `${s.csrf}x`, s.valor, "x", "%00", "a".repeat(5000)]) {
      const r = await cambiar({ csrf: malo });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ codigo: "csrf_invalido" });
    }
    await sigueIgual();
  });

  it("sin sesión la petición protegida da 401 antes que 403", async () => {
    const r = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seedAuth().tenantA } });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "sesion_invalida" });
  });
});

describe("CA-7 · Origin y Sec-Fetch-Site (D6)", () => {
  it("Origin ajeno con CSRF válido: 403 origen_invalido y no cambia el estado", async () => {
    const r = await cambiar({ origen: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "origen_invalido" });
    await sigueIgual();
  });

  it("Origin que solo se parece al de la app (sufijo, otro puerto, otro esquema, 'null') se rechaza", async () => {
    const base = new URL(ORIGEN);
    for (const o of [
      `${ORIGEN}.evil.example`,
      `${base.protocol}//${base.hostname}:9999`,
      `${base.protocol === "https:" ? "http:" : "https:"}//${base.host}`,
      `${base.protocol}//evil.${base.host}`,
      "null",
      "",
    ]) {
      const r = await cambiar({ origen: o });
      expect(r.status).toBe(403);
      expect(r.body.codigo).toBe("origen_invalido");
    }
    await sigueIgual();
  });

  it("sin Origin: Sec-Fetch-Site cross-site o same-site se rechaza; sin ninguno de los dos también", async () => {
    for (const sfs of ["cross-site", "same-site", "none"]) {
      const r = await cambiar({ origen: null, secFetchSite: sfs });
      expect(r.status).toBe(403);
      expect(r.body.codigo).toBe("origen_invalido");
    }
    const sinNada = await cambiar({ origen: null });
    expect(sinNada.status).toBe(403);
    expect(sinNada.body.codigo).toBe("origen_invalido");
    await sigueIgual();
  });

  it("Origin ajeno prevalece sobre un Sec-Fetch-Site same-origin falsificado", async () => {
    const r = await cambiar({ origen: "https://evil.example", secFetchSite: "same-origin" });
    expect(r.status).toBe(403);
  });

  it("control positivo: sin Origin pero con Sec-Fetch-Site same-origin y CSRF válido pasa", async () => {
    const otra = await h.entrar(u);
    const r = await h.pedir({
      ruta: "/auth/estudio",
      cuerpo: { tenantId: seedAuth().tenantA },
      cookie: otra.cookie,
      csrf: otra.csrf,
      origen: null,
      secFetchSite: "same-origin",
    });
    expect(r.status).toBe(200);
  });

  it("control positivo: Origin = APP_ORIGIN y CSRF válido pasa", async () => {
    const otra = await h.entrar(u);
    const r = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seedAuth().tenantB }, cookie: otra.cookie, csrf: otra.csrf });
    expect(r.status).toBe(200);
  });
});

describe("CA-7 · login, logout y recuperación también validan Origin (CSRF de login)", () => {
  it("login con Origin ajeno: 403, sin Set-Cookie y sin crear sesión, aunque la contraseña sea correcta", async () => {
    const v = await h.crearUsuario({ estudios: [] });
    const r = await h.login(v.correo, v.contrasena, { origen: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "origen_invalido" });
    expect(r.setCookies).toEqual([]);
    expect(await h.sesiones(v.id)).toHaveLength(0);
    const c = await h.login(v.correo, v.contrasena, { origen: null, secFetchSite: "cross-site" });
    expect(c.status).toBe(403);
    expect(await h.sesiones(v.id)).toHaveLength(0);
  });

  it("logout con Origin ajeno: 403 y la sesión sigue viva", async () => {
    const v = await h.crearUsuario({ estudios: [] });
    const sv = await h.entrar(v);
    const r = await h.pedir({ ruta: "/auth/logout", cuerpo: {}, cookie: sv.cookie, csrf: sv.csrf, origen: "https://evil.example" });
    expect(r.status).toBe(403);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: sv.cookie })).status).toBe(200);
  });

  it("logout con sesión pero sin CSRF: 403 y la sesión sigue viva", async () => {
    const v = await h.crearUsuario({ estudios: [] });
    const sv = await h.entrar(v);
    const r = await h.pedir({ ruta: "/auth/logout", cuerpo: {}, cookie: sv.cookie });
    expect(r.status).toBe(403);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: sv.cookie })).status).toBe(200);
  });

  it("cerrar-todas sin CSRF: 403 y no revoca nada", async () => {
    const v = await h.crearUsuario({ estudios: [] });
    const sv = await h.entrar(v);
    const r = await h.pedir({ ruta: "/auth/sesiones/cerrar-todas", cuerpo: {}, cookie: sv.cookie });
    expect(r.status).toBe(403);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: sv.cookie })).status).toBe(200);
  });

  it("recuperar y restablecer con Origin ajeno: 403 y no se envía ningún correo", async () => {
    const v = await h.crearUsuario({ estudios: [] });
    const r = await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: v.correo }, origen: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "origen_invalido" });
    const r2 = await h.pedir({
      ruta: "/auth/recuperar/restablecer",
      cuerpo: { token: "A".repeat(43), contrasena: "Contrasena-nueva-004-qWz" },
      origen: "https://evil.example",
    });
    expect(r2.status).toBe(403);
    await new Promise((r3) => setTimeout(r3, 300));
    expect(h.correo.para(v.correo)).toHaveLength(0);
  });
});

describe("CA-7 · ningún GET cambia estado", () => {
  const foto = async () =>
    (await h.sesiones(u.id)).map((f) => ({
      token_hash: f.token_hash.toString("hex"),
      tenant_activo: f.tenant_activo,
      revocada_en: f.revocada_en,
      motivo: f.motivo,
      expira_absoluta: f.expira_absoluta,
    }));

  it("GET /auth/sesion, /auth/estudios y /estudio/actual (con Origin ajeno o cross-site) no tocan sesiones", async () => {
    const antes = await foto();
    const extras = [{}, { origen: "https://evil.example" }, { secFetchSite: "cross-site" }];
    for (const e of extras) {
      await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie, ...e });
      await h.pedir({ ruta: "/auth/estudios", cookie: s.cookie, ...e });
      await h.pedir({ ruta: "/estudio/actual", cookie: s.cookie, estudio: seedAuth().tenantA, ...e });
    }
    expect(await foto()).toEqual(antes);
  });

  it("los GET sobre las rutas de acción no existen y no ejecutan nada (404 o 405)", async () => {
    const v = await h.crearUsuario({ estudios: [] });
    const sv = await h.entrar(v);
    for (const ruta of ["/auth/logout", "/auth/estudio", "/auth/sesiones/cerrar-todas", "/auth/contrasena", "/auth/recuperar", "/auth/recuperar/restablecer", "/auth/login"]) {
      const r = await h.pedir({ ruta, cookie: sv.cookie });
      expect([404, 405]).toContain(r.status);
    }
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: sv.cookie })).status).toBe(200);
  });

  it("GET /auth/sesion responde igual con y sin Origin (no es una acción protegida)", async () => {
    const a = await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie });
    const b = await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie, origen: "https://evil.example" });
    expect(forma(b)).toEqual(forma(a));
  });
});
