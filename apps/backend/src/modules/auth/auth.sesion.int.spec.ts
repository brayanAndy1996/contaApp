// T7 (004) · CA-4 (política y hash por HTTP), CA-5 (ciclo de vida), CA-6 (robo), P2 y P11 (cambio de contraseña).
// Rojo: `crearApp` aun no existe (T12).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  analizarSetCookie,
  atributo,
  COOKIE,
  cookieSesion,
  esHashDe,
  maxAge,
  seedAuth,
  type Harness,
  type UsuarioPrueba,
} from "../../../test/soporte.js";

let h: Harness;
beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  await h?.cerrar();
});

const NUEVA = "Contrasena-nueva-004-qWz";
const sesion = (cookie: string) => h.pedir({ ruta: "/auth/sesion", cookie });

describe("CA-5 · rotación del token", () => {
  it("al cambiar de estudio emite un token nuevo y el anterior deja de valer en el acto", async () => {
    const seed = seedAuth();
    const u = await h.crearUsuario({ estudios: [seed.tenantA, seed.tenantB] });
    const s1 = await h.entrar(u);
    const r = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seed.tenantA }, cookie: s1.cookie, csrf: s1.csrf });
    expect(r.status).toBe(200);
    expect(r.body.estudioActivo.id).toBe(seed.tenantA);
    const c2 = cookieSesion(r)!;
    expect(c2.valor).not.toBe(s1.valor);
    expect((await sesion(s1.cookie)).status).toBe(401);
    const nueva = await sesion(`${COOKIE}=${c2.valor}`);
    expect(nueva.status).toBe(200);
    expect(nueva.body.estudioActivo.id).toBe(seed.tenantA);
    expect(nueva.body.csrf).not.toBe(s1.csrf); // el token CSRF rota con la sesión
  });

  it("al cambiar la contraseña rota la sesión actual, revoca las demás y avisa al titular (P11, P9)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s1 = await h.entrar(u);
    const otra = await h.entrar(u);
    const r = await h.pedir({
      ruta: "/auth/contrasena",
      cuerpo: { actual: u.contrasena, nueva: NUEVA },
      cookie: s1.cookie,
      csrf: s1.csrf,
    });
    expect(r.status).toBe(204);
    const c2 = cookieSesion(r)!;
    expect(c2.valor).not.toBe(s1.valor);
    expect((await sesion(s1.cookie)).status).toBe(401);
    expect((await sesion(otra.cookie)).status).toBe(401);
    expect((await sesion(`${COOKIE}=${c2.valor}`)).status).toBe(200);
    expect((await h.login(u.correo, u.contrasena)).status).toBe(401);
    expect((await h.login(u.correo, NUEVA)).status).toBe(200);
    const avisos = await h.correo.esperar(u.correo, 1);
    expect(avisos.length).toBeGreaterThanOrEqual(1);
    expect(avisos.every((m) => !m.texto.includes(NUEVA) && !m.texto.includes(u.contrasena))).toBe(true);
  });

  it("la rotación nunca extiende la caducidad absoluta", async () => {
    const seed = seedAuth();
    const u = await h.crearUsuario({ estudios: [seed.tenantA, seed.tenantB] });
    const s1 = await h.entrar(u);
    await h.sql(
      "update auth.sesion set creada_en = now() - interval '11 hours', expira_absoluta = now() + interval '1 hour' where usuario_id = $1",
      [u.id],
    );
    const r = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seed.tenantA }, cookie: s1.cookie, csrf: s1.csrf });
    expect(r.status).toBe(200);
    const c = cookieSesion(r)!;
    expect(maxAge(c)).toBeLessThanOrEqual(3600);
    expect(maxAge(c)).toBeGreaterThan(3500);
    const filas = await h.sesiones(u.id);
    const viva = filas.find((f) => f.revocada_en === null)!;
    expect(esHashDe(viva.token_hash, c.valor)).toBe(true);
    expect(new Date(viva.expira_absoluta).getTime()).toBeLessThan(Date.now() + 3_700_000);
  });

  it("cambiar la contraseña con la actual equivocada da 401, sin cookie y sin cambiar nada", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    const r = await h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: "no-es-la-actual-Zz9", nueva: NUEVA }, cookie: s.cookie, csrf: s.csrf });
    expect(r.status).toBe(401);
    expect(r.setCookies).toEqual([]);
    expect((await h.login(u.correo, u.contrasena)).status).toBe(200);
  });

  it("POST /auth/contrasena sin sesión da 401 y sin CSRF da 403", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    expect((await h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: u.contrasena, nueva: NUEVA } })).status).toBe(401);
    const s = await h.entrar(u);
    const r = await h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: u.contrasena, nueva: NUEVA }, cookie: s.cookie });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "csrf_invalido" });
  });
});

describe("CA-5 · caducidades en el servidor (D3)", () => {
  it("2 h de inactividad: la sesión muere aunque el navegador conserve la cookie; a 1 h 50 min sigue viva", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    await h.sql("update auth.sesion set ultimo_uso = now() - interval '110 minutes' where usuario_id = $1", [u.id]);
    expect((await sesion(s.cookie)).status).toBe(200);
    await h.sql("update auth.sesion set ultimo_uso = now() - interval '125 minutes' where usuario_id = $1", [u.id]);
    const r = await sesion(s.cookie);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "sesion_invalida" });
  });

  it("12 h absolutas: la sesión muere aunque haya actividad reciente", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    await h.sql(
      "update auth.sesion set creada_en = now() - interval '13 hours', expira_absoluta = now() - interval '1 hour', ultimo_uso = now() where usuario_id = $1",
      [u.id],
    );
    expect((await sesion(s.cookie)).status).toBe(401);
  });

  it("el último uso se actualiza como máximo cada 5 min", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    const [a] = await h.sesiones(u.id);
    await sesion(s.cookie);
    await sesion(s.cookie);
    const [b] = await h.sesiones(u.id);
    expect(new Date(b.ultimo_uso).getTime()).toBe(new Date(a.ultimo_uso).getTime()); // < 5 min: no se toca
    await h.sql("update auth.sesion set ultimo_uso = now() - interval '10 minutes' where usuario_id = $1", [u.id]);
    await sesion(s.cookie);
    const [c] = await h.sesiones(u.id);
    expect(Date.now() - new Date(c.ultimo_uso).getTime()).toBeLessThan(60_000);
  });
});

describe("CA-5 · logout, cerrar todas y sin límites", () => {
  it("después del logout, reusar la cookie da 401 y se borra la cookie", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    const r = await h.pedir({ ruta: "/auth/logout", cookie: s.cookie, csrf: s.csrf, cuerpo: {} });
    expect(r.status).toBe(204);
    const c = analizarSetCookie(r.setCookies[0]!);
    expect(c.nombre).toBe(COOKIE);
    expect(c.valor).toBe("");
    expect(maxAge(c)).toBe(0);
    expect(atributo(c, "path")?.toLowerCase()).toBe("path=/");
    expect(atributo(c, "domain")).toBeUndefined();
    expect((await sesion(s.cookie)).status).toBe(401);
    const filas = await h.sesiones(u.id);
    expect(filas[0].revocada_en).not.toBeNull();
    expect(filas[0].motivo).toBe("logout");
  });

  it("logout sin sesión válida responde 204 igual", async () => {
    const r = await h.pedir({ ruta: "/auth/logout", cuerpo: {} });
    expect(r.status).toBe(204);
    const r2 = await h.pedir({ ruta: "/auth/logout", cuerpo: {}, cookie: `${COOKIE}=${"B".repeat(43)}` });
    expect(r2.status).toBe(204);
  });

  it("cerrar todas mis sesiones revoca todas las del usuario y solo las suyas (P2)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const ajeno = await h.crearUsuario({ estudios: [] });
    const s1 = await h.entrar(u);
    const s2 = await h.entrar(u);
    const sAjena = await h.entrar(ajeno);
    const r = await h.pedir({ ruta: "/auth/sesiones/cerrar-todas", cookie: s1.cookie, csrf: s1.csrf, cuerpo: {} });
    expect(r.status).toBe(204);
    expect(maxAge(analizarSetCookie(r.setCookies[0]!))).toBe(0);
    expect((await sesion(s1.cookie)).status).toBe(401);
    expect((await sesion(s2.cookie)).status).toBe(401);
    expect((await sesion(sAjena.cookie)).status).toBe(200);
  });

  it("no hay límite de sesiones simultáneas ni 'recordarme' (P6, P10)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const todas = [];
    for (let i = 0; i < 7; i++) todas.push(await h.entrar(u));
    for (const s of todas) expect((await sesion(s.cookie)).status).toBe(200);
    const conRecordar = await h.pedir({ ruta: "/auth/login", cuerpo: { correo: u.correo, contrasena: u.contrasena, recordarme: true } });
    const c = cookieSesion(conRecordar);
    if (c) expect(maxAge(c)).toBeLessThanOrEqual(43_200);
  });
});

describe("CA-5 y CA-6 · cookies mal formadas y robo", () => {
  it("un volcado de la tabla de sesiones no sirve: el token_hash copiado como cookie da 401", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    await h.entrar(u);
    const [fila] = await h.sesiones(u.id);
    const hash: Buffer = fila.token_hash;
    expect((await sesion(`${COOKIE}=${hash.toString("base64url")}`)).status).toBe(401);
    expect((await sesion(`${COOKIE}=${hash.toString("hex")}`)).status).toBe(401);
    expect((await sesion(`${COOKIE}=${hash.toString("base64")}`)).status).toBe(401);
  });

  it("formatos que no son un token de 43 caracteres base64url dan 401", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    for (const malo of [s.valor.slice(0, 42), `${s.valor}A`, `${s.valor.slice(0, 42)}=`, "", "x", " ".repeat(43), `${s.valor.slice(0, 42)}*`]) {
      expect((await sesion(`${COOKIE}=${malo}`)).status).toBe(401);
    }
  });

  it("varias cookies de sesión en la petición no autentican", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    const r = await sesion(`${s.cookie}; ${COOKIE}=${"C".repeat(43)}`);
    expect(r.status).toBe(401);
    const r2 = await sesion(`${COOKIE}=${"C".repeat(43)}; ${s.cookie}`);
    expect(r2.status).toBe(401);
  });

  it("una cookie con otro nombre (sin el prefijo __Host-) no autentica", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    expect((await sesion(`contapp_sid=${s.valor}`)).status).toBe(401);
    expect((await sesion(`__Secure-contapp_sid=${s.valor}`)).status).toBe(401);
  });

  it("el token CSRF no está en la BD ni coincide con el token de sesión", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    const r = await h.sql("select count(*)::int as n from auth.sesion s where s::text like '%' || $1 || '%'", [s.csrf]);
    expect(r[0].n).toBe(0);
    expect(s.csrf).not.toBe(s.valor);
  });
});

describe("CA-4 · política de contraseña nueva por HTTP", () => {
  const comun = readFileSync(new URL("./contrasena/comunes.txt", import.meta.url), "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().length >= 12)!;

  async function cambiar(u: UsuarioPrueba, nueva: string) {
    const s = await h.entrar(u);
    const antes = h.hasher.calculos;
    const r = await h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: u.contrasena, nueva }, cookie: s.cookie, csrf: s.csrf });
    return { r, s, calculos: h.hasher.calculos - antes };
  }

  it("menos de 12 caracteres: 400 contrasena_invalida (longitud) sin calcular hash", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const { r, calculos } = await cambiar(u, "Corta-1234"); // 10
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "contrasena_invalida", motivo: "longitud" });
    expect(calculos).toBe(0);
  });

  it("más de 128 puntos de código se rechaza antes de calcular el hash", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const { r, calculos } = await cambiar(u, "😀".repeat(129));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "contrasena_invalida", motivo: "longitud" });
    expect(calculos).toBe(0);
  });

  it("12 y 128 puntos de código se aceptan (se cuentan puntos de código, no unidades UTF-16)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    expect((await cambiar(u, "ñandú-ñandú1")).r.status).toBe(204);
    const v = { ...u, contrasena: "ñandú-ñandú1" };
    expect((await cambiar(v, "😀".repeat(128))).r.status).toBe(204);
  });

  it("una contraseña de la lista de comunes se rechaza (sin distinguir mayúsculas)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    expect(comun.length).toBeGreaterThanOrEqual(12);
    for (const variante of [comun, comun.toUpperCase()]) {
      const { r, calculos } = await cambiar(u, variante);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ codigo: "contrasena_invalida", motivo: "comun" });
      expect(calculos).toBe(0);
    }
  });

  it("sin reglas de composición: una frase en minúsculas de 12 o más caracteres es válida", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    expect((await cambiar(u, "correcto caballo bateria grapa")).r.status).toBe(204);
  });

  it("se guarda en PHC Argon2id con parámetros >= el piso y sal única", async () => {
    const a = await h.crearUsuario({ estudios: [] });
    const b = await h.crearUsuario({ estudios: [] });
    expect((await cambiar(a, NUEVA)).r.status).toBe(204);
    expect((await cambiar(b, NUEVA)).r.status).toBe(204);
    const filas = await h.sql("select hash from auth.usuario_contrasena where usuario_id = any($1::uuid[])", [[a.id, b.id]]);
    expect(filas).toHaveLength(2);
    const sales = filas.map((f) => {
      const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$/.exec(f.hash);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(19456);
      expect(Number(m![2])).toBeGreaterThanOrEqual(2);
      expect(Number(m![3])).toBeGreaterThanOrEqual(1);
      return m![4];
    });
    expect(sales[0]).not.toBe(sales[1]);
    expect(filas[0].hash).not.toBe(filas[1].hash);
  });
});
