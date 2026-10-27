/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 004 · Ronda adversarial 1a (lista mínima, caja negra). Solo usa el contrato público
// (`crearApp` vía el harness de T7, HTTP) y, como prevé el plan, la conexión de migraciones para
// mover marcas de tiempo. Cada prueba afirma el comportamiento SEGURO; si falla, es un hallazgo.
// Usuarios, correos e IPs únicos por ejecución; `afterAll` limpia solo lo creado aquí.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  capturarLogs,
  claveCorreo,
  COOKIE,
  cookieSesion,
  forma,
  hashesPosibles,
  ipUnica,
  maxAge,
  normalizar,
  pausa,
  seedAuth,
  sha256,
  type CookieSet,
  type Harness,
  type Peticion,
  type Resp,
  type SeedAuth,
} from "../../../test/soporte.js";

let h: Harness;
let S: SeedAuth;
const ips: string[] = [];
const correosRecuperados: string[] = [];

const ip = (): string => {
  const v = ipUnica();
  ips.push(v);
  return v;
};
const hex = (n = 6): string => randomBytes(n).toString("hex");
const nuevaContrasena = (): string => `Nueva-r1a-${hex()}-clave`;
const valorCookie = (r: Resp): string | undefined => cookieSesion(r)?.valor;
const kc = (valor: string): string => `${COOKIE}=${valor}`;
/** `forma` sin el valor de `Set-Cookie` (solo su número), para no imprimir tokens si una aserción falla. */
const formaS = (r: Resp) => {
  const f = forma(r);
  const cab = { ...f.headers };
  if (cab["set-cookie"] !== undefined) cab["set-cookie"] = `[${r.setCookies.length} cookie(s)]`;
  return { ...f, headers: cab };
};

const login = (correo: string, contrasena: string, extra: Partial<Peticion> = {}) =>
  h.pedir({ ruta: "/auth/login", cuerpo: { correo, contrasena }, ip: ip(), ...extra });
const entrar = (u: { correo: string; contrasena: string }, extra: Partial<Peticion> = {}) =>
  h.entrar(u, { ip: ip(), ...extra });
const sesion = (cookie: string) => h.pedir({ ruta: "/auth/sesion", cookie });
const csrfDe = async (cookie: string): Promise<string> => (await sesion(cookie)).body.csrf;
const recuperar = (correo: string, extra: Partial<Peticion> = {}) => {
  correosRecuperados.push(correo);
  return h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo }, ip: ip(), ...extra });
};
const restablecer = (token: string, contrasena: string, extra: Partial<Peticion> = {}) =>
  h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token, contrasena }, ip: ip(), ...extra });
const actual = (cookie: string, estudio: string | null) =>
  h.pedir({ ruta: "/estudio/actual", cookie, estudio });

/** Espera un enlace de recuperación nuevo (no visto antes) en el buzón de `correo`. */
const vistos = new Set<string>();
async function tokenNuevo(correo: string, ms = 3000): Promise<string> {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    for (const m of h.correo.para(normalizar(correo))) {
      const t = /#t=([A-Za-z0-9_-]+)/.exec(m.texto)?.[1];
      if (t && !vistos.has(t)) {
        vistos.add(t);
        return t;
      }
    }
    await pausa(25);
  }
  throw new Error("no llegó un enlace de recuperación nuevo");
}

/** Cuenta verificaciones (reales + ficticias) y cálculos del Hasher durante `fn`. */
async function medir(fn: () => Promise<Resp>) {
  const a = h.hasher.marca();
  const r = await fn();
  const b = h.hasher.marca();
  return {
    r,
    verif: b.reales - a.reales + (b.ficticias - a.ficticias),
    reales: b.reales - a.reales,
    calc: b.calculos - a.calculos,
  };
}

/** Flags de D5 sobre un Set-Cookie de sesión. */
function flagsD5(c: CookieSet | undefined, etiqueta: string, borrado = false): void {
  expect.soft(c, `${etiqueta}: Set-Cookie de sesión`).toBeDefined();
  if (!c) return;
  const at = c.atributos.map((a) => a.toLowerCase().replace(/\s+/g, ""));
  expect.soft(c.nombre, `${etiqueta}: nombre`).toBe(COOKIE);
  expect.soft(at.includes("httponly"), `${etiqueta}: HttpOnly`).toBe(true);
  expect.soft(at.includes("secure"), `${etiqueta}: Secure`).toBe(true);
  expect.soft(at.includes("samesite=lax"), `${etiqueta}: SameSite=Lax`).toBe(true);
  expect.soft(at.includes("path=/"), `${etiqueta}: Path=/`).toBe(true);
  expect.soft(at.some((a) => a.startsWith("domain")), `${etiqueta}: sin Domain`).toBe(false);
  if (borrado) {
    const expira = at.find((a) => a.startsWith("expires="));
    const pasado = expira ? Date.parse(expira.slice(8)) < Date.now() : false;
    expect.soft(maxAge(c) === 0 || pasado, `${etiqueta}: borrado (Max-Age=0)`).toBe(true);
    expect.soft(c.valor === "", `${etiqueta}: valor vacío al borrar`).toBe(true);
  }
}

/** Nombres de los secretos que aparecen en `texto` (nunca imprime los valores). */
const fugas = (texto: string, secretos: Record<string, string>): string[] =>
  Object.entries(secretos)
    .filter(([, v]) => v.length > 0 && texto.includes(v))
    .map(([k]) => k);

beforeAll(async () => {
  S = seedAuth();
  h = await abrirHarness();
});

afterAll(async () => {
  if (!h) return;
  await h
    .sql("delete from auth.limite_tasa where sujeto = any($1::text[])", [ips])
    .catch(() => undefined);
  const candidatos = correosRecuperados.flatMap((c) => {
    const k = claveCorreo(c);
    return [normalizar(c), k.toString("hex"), `\\x${k.toString("hex")}`, k.toString("base64"), k.toString("base64url")];
  });
  await h
    .sql("delete from auth.limite_tasa where tipo = 'recup_correo' and sujeto = any($1::text[])", [candidatos])
    .catch(() => undefined);
  await h.cerrar();
});

describe("004 · ronda adversarial 1a (lista mínima, caja negra)", () => {
  it("R1a-01 fijación: el login nunca promueve una cookie previa (aleatoria ni de otra cuenta)", async () => {
    const victima = await h.crearUsuario({ estudios: [S.tenantA] });
    const atacante = await h.crearUsuario({ estudios: [S.tenantA] });

    const plantada = randomBytes(32).toString("base64url");
    const l1 = await login(victima.correo, victima.contrasena, { cookie: kc(plantada) });
    expect(l1.status).toBe(200);
    const v1 = valorCookie(l1);
    expect(v1).toBeDefined();
    expect(v1 === plantada, "el login reusó la cookie plantada").toBe(false);
    expect((await sesion(kc(plantada))).status).toBe(401);
    const conHashPlantado = await h.sql("select 1 from auth.sesion where token_hash = any($1::bytea[])", [
      hashesPosibles(plantada),
    ]);
    expect(conHashPlantado.length).toBe(0);

    // Cookie válida del atacante plantada en el navegador de la víctima.
    const sa = await entrar(atacante);
    const l2 = await login(victima.correo, victima.contrasena, { cookie: sa.cookie });
    expect(l2.status).toBe(200);
    const v2 = valorCookie(l2) ?? "";
    expect(v2 === sa.valor, "el login reusó la cookie del atacante").toBe(false);
    const conCookieAtacante = await sesion(sa.cookie);
    expect(
      conCookieAtacante.status === 401 || conCookieAtacante.body?.usuario?.id === atacante.id,
      "la cookie del atacante quedó autenticada como la víctima",
    ).toBe(true);
    expect((await sesion(kc(v2))).body?.usuario?.id).toBe(victima.id);
  });

  it("R1a-02 ciclo de vida: rotación en estudio y contraseña, flags D5, logout y cerrar-todas", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA, S.tenantB] });
    const s1 = await entrar(u);
    const c0 = cookieSesion(s1.login);
    flagsD5(c0, "login");
    const max0 = c0 ? maxAge(c0) : Number.NaN;
    expect.soft(max0, "Max-Age del login ≈ 12 h").toBeGreaterThan(12 * 3600 - 120);
    expect.soft(max0, "Max-Age del login ≤ 12 h").toBeLessThanOrEqual(12 * 3600);

    // Cambio de estudio: rota token y CSRF; la cookie anterior muere en el acto.
    const r1 = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: S.tenantA }, cookie: s1.cookie, csrf: s1.csrf });
    expect(r1.status).toBe(200);
    const c1 = cookieSesion(r1);
    flagsD5(c1, "cambio de estudio");
    const v1 = c1?.valor ?? "";
    expect(v1 !== s1.valor && v1 !== "").toBe(true);
    expect.soft(maxAge(c1 as CookieSet), "la rotación no alarga la absoluta").toBeLessThanOrEqual(max0);
    expect((await sesion(s1.cookie)).status, "cookie previa al cambio de estudio").toBe(401);
    const viejoCsrf = await h.pedir({
      ruta: "/auth/estudio",
      cuerpo: { tenantId: S.tenantB },
      cookie: kc(v1),
      csrf: s1.csrf,
      estudio: S.tenantA,
    });
    expect(viejoCsrf.status, "CSRF de la sesión rotada").toBe(403);
    const csrf1 = await csrfDe(kc(v1));
    expect(csrf1 !== s1.csrf).toBe(true);

    // Cambio de contraseña: rota la actual y revoca las demás.
    const s2 = await entrar(u);
    const nueva = nuevaContrasena();
    const rc = await h.pedir({
      ruta: "/auth/contrasena",
      cuerpo: { actual: u.contrasena, nueva },
      cookie: kc(v1),
      csrf: csrf1,
      estudio: S.tenantA,
    });
    expect(rc.status).toBe(204);
    const c2 = cookieSesion(rc);
    flagsD5(c2, "cambio de contraseña");
    const v2 = c2?.valor ?? "";
    expect(v2 !== v1 && v2 !== "").toBe(true);
    expect.soft(maxAge(c2 as CookieSet)).toBeLessThanOrEqual(max0);
    expect((await sesion(kc(v1))).status, "cookie previa al cambio de contraseña").toBe(401);
    expect((await sesion(s2.cookie)).status, "otra sesión tras cambio de contraseña").toBe(401);
    expect((await sesion(kc(v2))).status).toBe(200);
    expect((await login(u.correo, u.contrasena)).status, "contraseña vieja").toBe(401);

    // Logout: 204, borra la cookie con los mismos flags y el reuso da 401.
    const lo = await h.pedir({ ruta: "/auth/logout", cuerpo: {}, cookie: kc(v2), csrf: await csrfDe(kc(v2)), estudio: S.tenantA });
    expect(lo.status).toBe(204);
    flagsD5(cookieSesion(lo), "logout", true);
    expect((await sesion(kc(v2))).status, "reuso tras logout").toBe(401);

    // Cerrar todas: revoca todas y borra la cookie.
    const s3 = await entrar({ correo: u.correo, contrasena: nueva });
    const s4 = await entrar({ correo: u.correo, contrasena: nueva });
    const ct = await h.pedir({ ruta: "/auth/sesiones/cerrar-todas", cuerpo: {}, cookie: s3.cookie, csrf: s3.csrf });
    expect(ct.status).toBe(204);
    flagsD5(cookieSesion(ct), "cerrar-todas", true);
    expect((await sesion(s3.cookie)).status).toBe(401);
    expect((await sesion(s4.cookie)).status).toBe(401);
  });

  it("R1a-03 CSRF y Origin: matriz en rutas con sesión, CSRF de login/recuperación y GET sin efectos", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA, S.tenantB] });
    const otro = await h.crearUsuario({ estudios: [S.tenantA] });
    const s0 = await entrar(u);
    const rA = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: S.tenantA }, cookie: s0.cookie, csrf: s0.csrf });
    expect(rA.status).toBe(200);
    const k = kc(valorCookie(rA) ?? "");
    const csrf = await csrfDe(k);
    const sOtro = await entrar(otro);

    const cambiarAB = (extra: Partial<Peticion>) =>
      h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: S.tenantB }, cookie: k, estudio: S.tenantA, csrf, ...extra });
    const casos: [string, Partial<Peticion>][] = [
      ["sin X-CSRF-Token", { csrf: null }],
      ["CSRF de otra sesión", { csrf: sOtro.csrf }],
      ["CSRF truncado", { csrf: csrf.slice(0, -1) }],
      ["CSRF alterado (misma longitud)", { csrf: `${csrf.slice(0, -1)}${csrf.endsWith("A") ? "B" : "A"}` }],
      ["Origin ajeno", { origen: "https://evil.example" }],
      ["Origin con sufijo", { origen: "http://localhost:3000.evil.example" }],
      ["Origin null", { origen: "null" }],
      ["sin Origin, Sec-Fetch-Site cross-site", { origen: null, secFetchSite: "cross-site" }],
      ["sin Origin, Sec-Fetch-Site same-site", { origen: null, secFetchSite: "same-site" }],
      ["sin Origin ni Sec-Fetch-Site", { origen: null }],
    ];
    for (const [etiqueta, extra] of casos) {
      const r = await cambiarAB(extra);
      expect.soft(r.status, `POST /auth/estudio · ${etiqueta}`).toBe(403);
      expect.soft(r.setCookies.length, `POST /auth/estudio · ${etiqueta}: sin Set-Cookie`).toBe(0);
    }
    // Nada cambió: la cookie sigue viva y el estudio sigue siendo A.
    expect((await sesion(k)).status).toBe(200);
    const act = await actual(k, S.tenantA);
    expect(act.status).toBe(200);
    expect(act.body.id).toBe(S.tenantA);

    // Logout y cerrar-todas también exigen CSRF de la propia sesión.
    const lo = await h.pedir({ ruta: "/auth/logout", cuerpo: {}, cookie: k, estudio: S.tenantA });
    expect.soft(lo.status, "logout sin CSRF").toBe(403);
    const ct = await h.pedir({ ruta: "/auth/sesiones/cerrar-todas", cuerpo: {}, cookie: k, csrf: sOtro.csrf, estudio: S.tenantA });
    expect.soft(ct.status, "cerrar-todas con CSRF ajeno").toBe(403);
    expect((await sesion(k)).status, "la sesión sobrevive a logout/cerrar-todas forjados").toBe(200);
    expect((await sesion(sOtro.cookie)).status).toBe(200);

    // GET nunca cambia estado.
    for (const ruta of ["/auth/logout", "/auth/sesiones/cerrar-todas", `/auth/estudio?tenantId=${S.tenantB}`]) {
      await h.pedir({ metodo: "GET", ruta, cookie: k, estudio: S.tenantA });
    }
    expect((await sesion(k)).status, "un GET revocó la sesión").toBe(200);
    expect((await actual(k, S.tenantA)).body.id, "un GET cambió el estudio").toBe(S.tenantA);

    // CSRF de login: credenciales válidas desde un origen ajeno no emiten sesión.
    for (const [etiqueta, extra] of [
      ["Origin ajeno", { origen: "https://evil.example" }],
      ["sin Origin ni Sec-Fetch-Site", { origen: null }],
      ["sin Origin, cross-site", { origen: null, secFetchSite: "cross-site" }],
    ] as [string, Partial<Peticion>][]) {
      const r = await login(otro.correo, otro.contrasena, extra);
      expect.soft(r.status, `login · ${etiqueta}`).toBe(403);
      expect.soft(r.setCookies.length, `login · ${etiqueta}: sin Set-Cookie`).toBe(0);
    }

    // Recuperación y restablecer desde un origen ajeno: 403 y sin efectos.
    const antes = h.correo.para(otro.correo).length;
    const rec = await recuperar(otro.correo, { origen: "https://evil.example" });
    expect.soft(rec.status, "recuperar · Origin ajeno").toBe(403);
    await pausa(300);
    expect.soft(h.correo.para(otro.correo).length, "recuperar ajeno envió correo").toBe(antes);
    expect((await recuperar(otro.correo)).status).toBe(202);
    const t = await tokenNuevo(otro.correo);
    const rs = await restablecer(t, nuevaContrasena(), { origen: "https://evil.example" });
    expect.soft(rs.status, "restablecer · Origin ajeno").toBe(403);
    expect((await login(otro.correo, otro.contrasena)).status, "restablecer ajeno cambió la contraseña").toBe(200);

    // Al final (puede rotar la sesión): CA-7 pide 403 con `Sec-Fetch-Site` ajeno aunque `Origin` coincida.
    const mixto = await cambiarAB({ secFetchSite: "cross-site" });
    expect.soft(mixto.status, "POST /auth/estudio · Origin correcto con Sec-Fetch-Site cross-site").toBe(403);
  });

  it("R1a-04 enumeración en login: inexistente, errónea, bloqueada y variantes dan la misma respuesta", async () => {
    const e = await h.crearUsuario({ estudios: [S.tenantA] });
    const eb = await h.crearUsuario({ estudios: [S.tenantA] });
    const n = h.correoInexistente();
    const plantada = kc(randomBytes(32).toString("base64url"));
    const mala = `Erronea-${hex()}-x`;
    const pedirL = (c: string, p: string) => medir(() => login(c, p, { cookie: plantada }));

    for (let i = 0; i < 5; i++) await login(eb.correo, mala);

    const erronea = await pedirL(e.correo, mala);
    expect(erronea.r.status).toBe(401);
    expect(erronea.r.body).toEqual({ codigo: "credenciales_invalidas" });
    const ramas: Record<string, Awaited<ReturnType<typeof pedirL>>> = {
      inexistente: await pedirL(n, mala),
      bloqueada: await pedirL(eb.correo, eb.contrasena),
      "existente MAYÚS+espacios": await pedirL(`  ${e.correo.toUpperCase()} `, mala),
      "inexistente MAYÚS+espacios": await pedirL(`  ${n.toUpperCase()} `, mala),
    };
    expect.soft(erronea.verif, "errónea: una verificación").toBe(1);
    expect.soft(erronea.r.setCookies.length, "errónea: sin Set-Cookie").toBe(0);
    for (const [nombre, x] of Object.entries(ramas)) {
      if (nombre.includes("MAYÚS")) continue;
      expect.soft(formaS(x.r), `${nombre} vs errónea`).toEqual(formaS(erronea.r));
      expect.soft(x.verif, `${nombre}: una verificación`).toBe(1);
      expect.soft(x.r.setCookies.length, `${nombre}: sin Set-Cookie`).toBe(0);
    }
    const ve = ramas["existente MAYÚS+espacios"];
    const vn = ramas["inexistente MAYÚS+espacios"];
    expect.soft(formaS(ve!.r), "variante existente vs variante inexistente").toEqual(formaS(vn!.r));
    expect.soft(ve!.verif, "variantes: mismo número de verificaciones").toBe(vn!.verif);

    // Contraseña gigante (DoS, P5): 401 genérico sin calcular Argon2, igual exista o no el correo.
    const gigante = "x".repeat(5000);
    const ge = await pedirL(e.correo, gigante);
    const gn = await pedirL(n, gigante);
    expect.soft(formaS(ge.r), "gigante existente vs errónea").toEqual(formaS(erronea.r));
    expect.soft(formaS(gn.r), "gigante inexistente vs errónea").toEqual(formaS(erronea.r));
    expect.soft(ge.verif + ge.calc, "gigante: sin Argon2").toBe(0);
    expect.soft(gn.verif + gn.calc, "gigante inexistente: sin Argon2").toBe(0);
  });

  it("R1a-05 enumeración en recuperación: misma respuesta y mismo 429, y las variantes no saltan el límite", async () => {
    const r = await h.crearUsuario({ estudios: [S.tenantA] });
    const n = h.correoInexistente();
    const variantes = [(c: string) => c, (c: string) => c.toUpperCase(), (c: string) => `  ${c} `, (c: string) => c.replace(/^./, (x) => x.toUpperCase())];
    for (const [i, v] of variantes.entries()) {
      const re = await recuperar(v(r.correo));
      const rn = await recuperar(v(n));
      expect.soft(formaS(re), `ronda ${i + 1}: existente vs inexistente`).toEqual(formaS(rn));
      expect.soft(re.setCookies.length, `ronda ${i + 1}: sin Set-Cookie`).toBe(0);
      if (i === 0) expect(re.status).toBe(202);
    }
    await pausa(500);
    expect.soft(h.correo.para(r.correo).length, "más de 3 correos/h por variantes del mismo correo").toBeLessThanOrEqual(3);
    expect(h.correo.para(n).length).toBe(0);
  });

  it("R1a-06 bloqueo: 20 fallos concurrentes con variantes del correo → ≤ 5 reales; se levanta al vencer y un éxito reinicia", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA] });
    const variantes = [u.correo, u.correo.toUpperCase(), `  ${u.correo}  `, `\t${u.correo.toUpperCase()}\n`, u.correo.replace(/^u/, "U")];
    const a = h.hasher.marca();
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => login(variantes[i % variantes.length] ?? u.correo, `Erronea-${i}-${hex(3)}`)),
    );
    const b = h.hasher.marca();
    const n401 = rs.filter((x) => x.status === 401).length;
    expect(rs.every((x) => x.status === 401 || x.status === 400), "solo 401 (o 400 por formato)").toBe(true);
    expect(n401, "al menos las variantes sin espacios llegan al contador").toBeGreaterThanOrEqual(12);
    expect(b.reales - a.reales, "verificaciones contra el hash real").toBeLessThanOrEqual(5);
    expect(b.reales - a.reales + (b.ficticias - a.ficticias), "una verificación por intento 401").toBe(n401);

    const bloq = await login(u.correo, u.contrasena);
    expect(bloq.status, "contraseña correcta durante el bloqueo").toBe(401);
    expect(bloq.setCookies.length).toBe(0);
    const [fila] = await h.sql<{ resta: number }>(
      "select extract(epoch from (bloqueado_hasta - now()))::float8 as resta from auth.intento_login where clave = $1",
      [claveCorreo(u.correo)],
    );
    expect(fila?.resta, "bloqueo ≈ 15 min").toBeGreaterThan(14 * 60 - 30);
    expect(fila?.resta, "bloqueo ≤ 15 min").toBeLessThanOrEqual(15 * 60 + 1);

    // Desbloqueo esperando (se simula moviendo las marcas, como prevé el plan).
    await h.sql(
      "update auth.intento_login set bloqueado_hasta = now() - interval '1 second', ventana_inicio = now() - interval '16 minutes' where clave = $1",
      [claveCorreo(u.correo)],
    );
    expect((await login(u.correo, u.contrasena)).status, "tras vencer el bloqueo").toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(u.correo, `Erronea-b-${i}-xxxx`)).status).toBe(401);
    expect((await login(u.correo, u.contrasena)).status, "el éxito reinició el contador").toBe(200);
  });

  it("R1a-07 recuperación: un uso, 30 min, alterado/truncado, pedir otro invalida, política antes del token y desbloqueo", async () => {
    // Cuenta bloqueada que se desbloquea restableciendo.
    const r2 = await h.crearUsuario({ estudios: [S.tenantA] });
    for (let i = 0; i < 5; i++) await login(r2.correo, `Erronea-${i}-${hex(3)}`);
    expect((await login(r2.correo, r2.contrasena)).status).toBe(401);

    expect((await recuperar(r2.correo)).status).toBe(202);
    const tVencido = await tokenNuevo(r2.correo);
    const [dur] = await h.sql<{ s: number }>(
      "select extract(epoch from (expira_en - creado_en))::float8 as s from auth.token_recuperacion where usuario_id = $1 and usado_en is null and invalidado_en is null",
      [r2.id],
    );
    expect(dur?.s, "caducidad del token = 30 min").toBeGreaterThan(30 * 60 - 2);
    expect(dur?.s).toBeLessThanOrEqual(30 * 60 + 2);
    await h.sql(
      "update auth.token_recuperacion set creado_en = creado_en - interval '30 minutes 1 second', expira_en = expira_en - interval '30 minutes 1 second' where usuario_id = $1 and usado_en is null and invalidado_en is null",
      [r2.id],
    );
    const vencido = await restablecer(tVencido, nuevaContrasena());
    expect(vencido.status, "token vencido").toBe(400);
    expect(vencido.body).toEqual({ codigo: "token_invalido" });

    expect((await recuperar(r2.correo)).status).toBe(202);
    const t2 = await tokenNuevo(r2.correo);
    const alterado = `${t2.slice(0, -1)}${t2.endsWith("A") ? "B" : "A"}`;
    for (const [etiqueta, tok] of [
      ["truncado", t2.slice(0, -1)],
      ["alterado", alterado],
      ["aleatorio", randomBytes(32).toString("base64url")],
    ] as const) {
      expect.soft(formaS(await restablecer(tok, nuevaContrasena())), `token ${etiqueta}`).toEqual(formaS(vencido));
    }
    // Política antes de tocar el token: no calcula hash ni consume.
    const gig = await medir(() => restablecer(t2, "y".repeat(129)));
    expect(gig.r.status).toBe(400);
    expect.soft(gig.r.body?.codigo).toBe("contrasena_invalida");
    expect.soft(gig.calc, "política: sin Argon2").toBe(0);
    const nueva2 = nuevaContrasena();
    expect((await restablecer(t2, nueva2)).status, "el token sigue vivo tras un rechazo de política").toBe(204);
    expect.soft(formaS(await restablecer(t2, nuevaContrasena())), "token reusado").toEqual(formaS(vencido));
    expect((await login(r2.correo, nueva2)).status, "restablecer levanta el bloqueo").toBe(200);

    // Pedir otro invalida el anterior; cambiar la contraseña con sesión invalida los vivos.
    const r = await h.crearUsuario({ estudios: [S.tenantA] });
    await recuperar(r.correo);
    const t1 = await tokenNuevo(r.correo);
    await recuperar(r.correo);
    const tVivo = await tokenNuevo(r.correo);
    expect.soft(formaS(await restablecer(t1, nuevaContrasena())), "token anterior al segundo pedido").toEqual(
      formaS(vencido),
    );
    const s = await entrar(r);
    const rc = await h.pedir({
      ruta: "/auth/contrasena",
      cuerpo: { actual: r.contrasena, nueva: nuevaContrasena() },
      cookie: s.cookie,
      csrf: s.csrf,
      estudio: S.tenantA,
    });
    expect(rc.status).toBe(204);
    const tras = await restablecer(tVivo, nuevaContrasena());
    expect(tras.status, "token de recuperación vivo tras cambiar la contraseña").toBe(400);
  });

  it("R1a-08 estudio: sin membresía, inexistente, revocado y X-Estudio ajeno", async () => {
    const u1 = await h.crearUsuario({ estudios: [S.tenantA] });
    const s1 = await entrar(u1);
    expect(s1.estudioActivo?.id, "un solo estudio queda activo (P7)").toBe(S.tenantA);
    const ajeno = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: S.tenantB }, cookie: s1.cookie, csrf: s1.csrf, estudio: S.tenantA });
    const inexistente = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: randomUUID() }, cookie: s1.cookie, csrf: s1.csrf, estudio: S.tenantA });
    expect(ajeno.status).toBe(403);
    expect(ajeno.body).toEqual({ codigo: "estudio_no_disponible" });
    expect.soft(formaS(inexistente), "inexistente vs sin membresía").toEqual(formaS(ajeno));
    expect.soft(ajeno.setCookies.length + inexistente.setCookies.length, "sin Set-Cookie").toBe(0);
    expect((await sesion(s1.cookie)).status, "el intento no revocó ni rotó la sesión").toBe(200);
    expect((await actual(s1.cookie, S.tenantA)).body.id).toBe(S.tenantA);
    const desfasado = await actual(s1.cookie, S.tenantB);
    expect(desfasado.status, "X-Estudio de otro estudio").toBe(409);
    expect(desfasado.text.includes(S.tenantB) || desfasado.text.includes(S.tenants.find((t) => t.id === S.tenantB)?.nombre ?? "\u0000")).toBe(false);

    // Membresía revocada con el estudio activo.
    const u2 = await h.crearUsuario({ estudios: [S.tenantA, S.tenantB] });
    const s2 = await entrar(u2);
    const elegido = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: S.tenantA }, cookie: s2.cookie, csrf: s2.csrf });
    expect(elegido.status).toBe(200);
    const k = kc(valorCookie(elegido) ?? "");
    await h.sql("delete from membresia where usuario_id = $1 and tenant_id = $2", [u2.id, S.tenantA]);
    const g1 = await actual(k, S.tenantA);
    expect(g1.status, "membresía revocada").toBe(403);
    expect(g1.body).toEqual({ codigo: "estudio_requerido" });
    expect((await actual(k, S.tenantA)).status, "sigue rechazado").toBe(403);
    const csrf = await csrfDe(k);
    const reelegir = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: S.tenantA }, cookie: k, csrf });
    expect.soft(formaS(reelegir), "re-elegir el estudio revocado").toEqual(formaS(ajeno));
    const aB = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: S.tenantB }, cookie: k, csrf });
    expect(aB.status).toBe(200);
    const kB = kc(valorCookie(aB) ?? "");
    expect((await actual(kB, S.tenantB)).body.id).toBe(S.tenantB);
    expect((await actual(kB, S.tenantA)).status, "X-Estudio del revocado").not.toBe(200);
    const lista = await h.pedir({ ruta: "/auth/estudios", cookie: kB });
    expect((lista.body as any[]).map((x) => x.id)).toEqual([S.tenantB]);
  });

  it("R1a-09 caducidades del servidor: 2 h de inactividad y 12 h absolutas", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA] });
    const s1 = await entrar(u);
    const [fila] = await h.sql<{ id: string }>(
      "select id from auth.sesion where token_hash = any($1::bytea[])",
      [hashesPosibles(s1.valor)],
    );
    expect(fila).toBeDefined();
    const mover = (set: string) => h.sql(`update auth.sesion set ${set} where id = $1`, [fila?.id]);

    await mover("creada_en = now() - interval '119 minutes', ultimo_uso = now() - interval '118 minutes'");
    expect((await sesion(s1.cookie)).status, "inactiva 1 h 58 min").toBe(200);
    const [uso] = await h.sql<{ s: number }>(
      "select extract(epoch from (now() - ultimo_uso))::float8 as s from auth.sesion where id = $1",
      [fila?.id],
    );
    expect.soft(uso?.s, "ultimo_uso se actualiza (> 5 min)").toBeLessThan(60);
    await mover("creada_en = now() - interval '125 minutes', ultimo_uso = now() - interval '121 minutes'");
    expect((await sesion(s1.cookie)).status, "inactiva 2 h 1 min").toBe(401);

    const s2 = await entrar(u);
    const [f2] = await h.sql<{ id: string }>("select id from auth.sesion where token_hash = any($1::bytea[])", [
      hashesPosibles(s2.valor),
    ]);
    await h.sql(
      "update auth.sesion set creada_en = now() - interval '721 minutes', expira_absoluta = now() - interval '1 minute', ultimo_uso = now() - interval '1 minute' where id = $1",
      [f2?.id],
    );
    expect((await sesion(s2.cookie)).status, "absoluta vencida con uso reciente").toBe(401);
  });

  it("R1a-10 sin fugas: contraseñas, tokens, CSRF y hashes ausentes de logs y respuestas", async () => {
    const pwd = `Canario-r1a-${hex()}-uno`;
    const u = await h.crearUsuario({ estudios: [S.tenantA], contrasena: pwd });
    const sec: Record<string, string> = {
      pwd,
      pwdMala: `Canario-r1a-${hex()}-mala`,
      pwdNueva: `Canario-r1a-${hex()}-nueva`,
      pwdActualMala: `Canario-r1a-${hex()}-actual`,
      pwdRest: `Canario-r1a-${hex()}-rest`,
      json: `Canario-r1a-${hex()}-json`,
      grande: `Canario-r1a-${hex()}-grande`,
    };
    const respuestas: Resp[] = [];
    const guardar = async (p: Promise<Resp>) => {
      const r = await p;
      respuestas.push(r);
      return r;
    };
    const { logs } = await capturarLogs(async () => {
      await guardar(login(u.correo, sec.pwdMala ?? ""));
      const s = await entrar(u);
      respuestas.push(s.login);
      sec.cookie1 = s.valor;
      sec.csrf1 = s.csrf;
      const rc = await guardar(
        h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: pwd, nueva: sec.pwdNueva }, cookie: s.cookie, csrf: s.csrf, estudio: S.tenantA }),
      );
      sec.cookie2 = valorCookie(rc) ?? "";
      const k2 = kc(sec.cookie2);
      const csrf2 = await csrfDe(k2);
      sec.csrf2 = csrf2;
      const ses = await guardar(sesion(k2));
      expect.soft(/hash|token|contrasena/i.test(JSON.stringify(ses.body)), "GET /auth/sesion sin hash ni token").toBe(false);
      await guardar(
        h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: sec.pwdActualMala, nueva: `${sec.pwdNueva}-2` }, cookie: k2, csrf: csrf2, estudio: S.tenantA }),
      );
      await guardar(h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: sec.pwdNueva, nueva: "corta" }, cookie: k2, csrf: csrf2, estudio: S.tenantA }));
      await guardar(recuperar(u.correo));
      sec.tokenRec = await tokenNuevo(u.correo);
      await guardar(restablecer(`${sec.tokenRec}x`, sec.pwdRest ?? ""));
      await guardar(restablecer(sec.tokenRec, sec.pwdRest ?? ""));
      await guardar(h.pedir({ ruta: "/auth/login", crudo: `{"correo":"${sec.json}","contrasena":`, ip: ip() }));
      await guardar(
        h.pedir({ ruta: "/auth/login", crudo: JSON.stringify({ correo: u.correo, contrasena: `${sec.grande}${"z".repeat(20_000)}` }), ip: ip() }),
      );
      await pausa(300);
    });
    for (const v of [sec.cookie1, sec.cookie2, sec.tokenRec]) {
      if (!v) continue;
      for (const hh of hashesPosibles(v)) {
        sec[`hashHex${hh.toString("hex").slice(0, 6)}`] = hh.toString("hex");
        sec[`hashB64${hh.toString("hex").slice(0, 6)}`] = hh.toString("base64url");
      }
    }
    sec.claveHex = claveCorreo(u.correo).toString("hex");
    sec.argon = "$argon2";
    sec.sha = sha256(pwd).toString("hex");

    expect(fugas(logs, sec), "secretos en logs").toEqual([]);
    const { csrf1: _c1, csrf2: _c2, ...sinCsrf } = sec;
    void _c1;
    void _c2;
    for (const r of respuestas) {
      const { "set-cookie": _sc, ...cab } = r.headers;
      void _sc;
      expect.soft(fugas(`${r.status} ${r.text}\n${JSON.stringify(cab)}`, sinCsrf), `secretos en respuesta ${r.status}`).toEqual([]);
      expect.soft(Object.keys(r.body ?? {}).filter((x) => /hash|token|contrasena|password/i.test(x)), "campos sensibles").toEqual([]);
    }
  });
});
