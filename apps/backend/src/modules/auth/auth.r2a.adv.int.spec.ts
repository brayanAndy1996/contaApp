/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas adversariales */
// Spec 004 · ronda adversarial 2a (T17a): regresión de las correcciones de la ronda 1 (commit 7ad23ad) por
// otras vías. Cada prueba afirma el comportamiento seguro esperado; si falla es un hallazgo (tasks.md, T17a).
//   H1  tokens de recuperación vivos invalidados por /auth/contrasena y por restablecer (también en carrera).
//   H2  `Origin` correcto con `Sec-Fetch-Site` ajeno (o raro, o duplicado) -> 403 exacto, sin efectos.
//   B1  (H-r1b-1) restablecer: 10 cada 15 min por IP, sin Argon2 con tokens inválidos; variantes de IP/XFF.
//   B2  (H-r1b-2) cambios correctos no bloquean; los fallos al cambiar cuentan y bloquean al 5.º.
//   B3  (H-r1b-3) charsets y codificaciones raras -> 4xx con solo {codigo}, nunca 500.
// Repetible: IPs, correos y usuarios únicos por ejecución; borra sus filas de limite_tasa (el harness, el resto).
// Nunca imprime contraseñas ni tokens.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  claveCorreo,
  COOKIE,
  cookieSesion,
  ipUnica,
  normalizar,
  ORIGEN,
  pausa,
  type Harness,
  type Resp,
} from "../../../test/soporte.js";

let h: Harness;
const sujetos: string[] = []; // sujetos exactos de auth.limite_tasa creados aquí
const prefijos6: string[] = []; // prefijos IPv6 (/64) creados aquí
const ip = (): string => {
  const v = ipUnica();
  sujetos.push(v);
  return v;
};

beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  if (!h) return;
  await h.sql("delete from auth.limite_tasa where sujeto = any($1::text[])", [sujetos]).catch(() => undefined);
  for (const p of prefijos6) {
    await h.sql("delete from auth.limite_tasa where sujeto like $1", [`${p}:%`]).catch(() => undefined);
  }
  await h.cerrar();
});

const nueva = (etq: string): string => `Frase-r2a-${etq}-${randomBytes(5).toString("hex")}-larga`;
const tokenInventado = (): string => randomBytes(32).toString("base64url");
const formaS = (r: Resp) => ({ status: r.status, body: r.body });
const csrfDe = async (cookie: string): Promise<string> => (await h.pedir({ ruta: "/auth/sesion", cookie })).body.csrf;
const cookieDe = (r: Resp): string => `${COOKIE}=${cookieSesion(r)?.valor ?? ""}`;
const restablecer = (token: string, contrasena: string, desde = ip()) =>
  h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token, contrasena }, ip: desde });
const recuperar = (correo: string) => h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo }, ip: ip() });

/** Todos los tokens `#t=` de los correos recibidos por `correo` (sin imprimirlos). */
const tokensDe = (correo: string): string[] =>
  h.correo
    .para(normalizar(correo))
    .map((m) => /#t=([A-Za-z0-9_-]+)/.exec(m.texto)?.[1])
    .filter((t): t is string => typeof t === "string");

/** Petición HTTP cruda: cabeceras repetidas y cuerpo en bytes arbitrarios. */
function crudo(o: {
  ruta: string;
  cabeceras: [string, string][];
  cuerpo?: Buffer | string;
}): Promise<{ status: number; body: any; texto: string; setCookie: string[] }> {
  const puerto = (h.app.getHttpServer().address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const planas: string[] = ["Host", `127.0.0.1:${puerto}`];
    for (const [k, v] of o.cabeceras) planas.push(k, v);
    const cuerpo = o.cuerpo === undefined ? undefined : Buffer.isBuffer(o.cuerpo) ? o.cuerpo : Buffer.from(o.cuerpo, "utf8");
    if (cuerpo) planas.push("Content-Length", String(cuerpo.length));
    const req = http.request(
      {
        host: "127.0.0.1",
        port: puerto,
        path: o.ruta,
        method: "POST",
        headers: planas as unknown as http.OutgoingHttpHeaders,
      },
      (res) => {
        const trozos: Buffer[] = [];
        res.on("data", (c: Buffer) => trozos.push(c));
        res.on("end", () => {
          const texto = Buffer.concat(trozos).toString("utf8");
          let body: any = {};
          try {
            body = texto ? JSON.parse(texto) : {};
          } catch {
            body = { crudo: "(no JSON)" };
          }
          const sc = res.headers["set-cookie"];
          resolve({ status: res.statusCode ?? 0, body, texto, setCookie: ([] as string[]).concat(sc ?? []) });
        });
      },
    );
    req.on("error", reject);
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

describe("r2a · H1: ningún token de recuperación anterior sobrevive a un cambio de contraseña", () => {
  it("tokens creados en paralelo mueren con /auth/contrasena y con restablecer; un restablecer en vuelo pierde la carrera", async () => {
    const invento = await restablecer(tokenInventado(), nueva("x"));
    expect(invento.status).toBe(400);

    // (a) 3 recuperaciones simultáneas (límite 3/h por correo): pueden quedar varios tokens vivos a la vez.
    const u = await h.crearUsuario();
    sujetos.push(claveCorreo(u.correo).toString("hex"));
    const rs = await Promise.all([1, 2, 3].map(() => recuperar(u.correo)));
    expect(rs.map((r) => r.status)).toEqual([202, 202, 202]);
    await h.correo.esperar(normalizar(u.correo), 3);
    const tokens = tokensDe(u.correo);
    expect(tokens.length).toBe(3);
    const s = await h.entrar(u, { ip: ip() });
    const cambio = await h.pedir({
      ruta: "/auth/contrasena",
      cuerpo: { actual: u.contrasena, nueva: nueva("h1a") },
      cookie: s.cookie,
      csrf: s.csrf,
      ip: ip(),
    });
    expect(cambio.status).toBe(204);
    const antes = h.hasher.calculos;
    for (const [i, t] of tokens.entries()) {
      expect.soft(formaS(await restablecer(t, nueva(`h1a${i}`))), `token ${i + 1} tras /auth/contrasena`).toEqual(formaS(invento));
    }
    expect.soft(h.hasher.calculos - antes, "Argon2 con tokens invalidados").toBe(0);

    // (b) Restablecer con un token invalida todos los demás (incluidos los creados en paralelo).
    const v = await h.crearUsuario();
    sujetos.push(claveCorreo(v.correo).toString("hex"));
    await Promise.all([1, 2, 3].map(() => recuperar(v.correo)));
    await h.correo.esperar(normalizar(v.correo), 3);
    const vivo = tokensDe(v.correo);
    expect(vivo.length).toBe(3);
    let usado = -1;
    for (const [i, t] of vivo.entries()) {
      if ((await restablecer(t!, nueva("h1b"))).status === 204) {
        usado = i;
        break;
      }
    }
    expect(usado, "al menos un token de los paralelos sirve").toBeGreaterThanOrEqual(0);
    for (const [i, t] of vivo.entries()) {
      if (i === usado) continue;
      expect.soft(formaS(await restablecer(t!, nueva("h1b2"))), `token ${i + 1} tras restablecer`).toEqual(formaS(invento));
    }

    // (c) Carrera: restablecer ya pasó `recuperacion_vigente` y está calculando Argon2 cuando el titular cambia
    // la contraseña. El consumo atómico debe fallar: la contraseña que queda es la del titular.
    const w = await h.crearUsuario();
    sujetos.push(claveCorreo(w.correo).toString("hex"));
    expect((await recuperar(w.correo)).status).toBe(202);
    await h.correo.esperar(normalizar(w.correo), 1);
    const [tw] = tokensDe(w.correo);
    const sw = await h.entrar(w, { ip: ip() });
    const original = h.hasher.calcular;
    let enEspera = false;
    let soltar: () => void = () => undefined;
    const compuerta = new Promise<void>((r) => (soltar = r));
    let primera = true;
    h.hasher.calcular = async (plano: string) => {
      if (primera) {
        primera = false;
        enEspera = true;
        await compuerta;
      }
      return original(plano);
    };
    try {
      const delAtacante = nueva("atacante");
      const delTitular = nueva("titular");
      const enVuelo = restablecer(tw!, delAtacante);
      for (let i = 0; i < 200 && !enEspera; i++) await pausa(10);
      expect(enEspera, "restablecer llegó al cálculo de Argon2").toBe(true);
      const c = await h.pedir({
        ruta: "/auth/contrasena",
        cuerpo: { actual: w.contrasena, nueva: delTitular },
        cookie: sw.cookie,
        csrf: sw.csrf,
        ip: ip(),
      });
      expect(c.status).toBe(204);
      soltar();
      const r = await enVuelo;
      expect.soft(formaS(r), "restablecer en vuelo tras el cambio del titular").toEqual(formaS(invento));
      expect.soft((await h.login(w.correo, delAtacante, { ip: ip() })).status, "vale la contraseña del atacante").toBe(401);
      expect((await h.login(w.correo, delTitular, { ip: ip() })).status, "vale la del titular").toBe(200);
    } finally {
      soltar();
      h.hasher.calcular = original;
    }
  });
});

describe("r2a · H2: Origin correcto no basta si Sec-Fetch-Site es ajeno", () => {
  it("logout y login con Origin correcto y Sec-Fetch-Site cross-site/same-site/none/raro/duplicado -> 403 origen_invalido sin efectos", async () => {
    const u = await h.crearUsuario();
    const s = await h.entrar(u, { ip: ip() });
    const base: [string, string][] = [
      ["Content-Type", "application/json"],
      ["Cookie", s.cookie],
      ["X-CSRF-Token", s.csrf],
    ];
    const casos: [string, [string, string][]][] = [
      ["cross-site", [["Origin", ORIGEN], ["Sec-Fetch-Site", "cross-site"]]],
      ["same-site", [["Origin", ORIGEN], ["Sec-Fetch-Site", "same-site"]]],
      ["none", [["Origin", ORIGEN], ["Sec-Fetch-Site", "none"]]],
      ["vacío", [["Origin", ORIGEN], ["Sec-Fetch-Site", ""]]],
      ["mayúsculas", [["Origin", ORIGEN], ["Sec-Fetch-Site", "Same-Origin"]]],
      ["same-origin + cross-site (dos cabeceras)", [["Origin", ORIGEN], ["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Site", "cross-site"]]],
      ["cross-site + same-origin (dos cabeceras)", [["Origin", ORIGEN], ["Sec-Fetch-Site", "cross-site"], ["Sec-Fetch-Site", "same-origin"]]],
      ["lista en una cabecera", [["Origin", ORIGEN], ["Sec-Fetch-Site", "same-origin, cross-site"]]],
      ["Origin correcto + ajeno (dos cabeceras)", [["Origin", ORIGEN], ["Origin", "https://evil.example"], ["Sec-Fetch-Site", "same-origin"]]],
      ["Origin ajeno + same-origin", [["Origin", "https://evil.example"], ["Sec-Fetch-Site", "same-origin"]]],
      ["Origin vacío + same-origin", [["Origin", ""], ["Sec-Fetch-Site", "same-origin"]]],
      ["Origin con barra final + same-origin", [["Origin", `${ORIGEN}/`], ["Sec-Fetch-Site", "same-origin"]]],
    ];
    for (const [etq, cab] of casos) {
      const ipC = ip();
      const r = await crudo({ ruta: "/auth/logout", cabeceras: [...base, ["X-Forwarded-For", ipC], ...cab], cuerpo: "{}" });
      expect.soft({ status: r.status, body: r.body }, `logout · ${etq}`).toEqual({ status: 403, body: { codigo: "origen_invalido" } });
      expect.soft(r.setCookie.length, `logout · ${etq}: sin Set-Cookie`).toBe(0);

      const l = await crudo({
        ruta: "/auth/login",
        cabeceras: [["Content-Type", "application/json"], ["X-Forwarded-For", ipC], ...cab],
        cuerpo: JSON.stringify({ correo: u.correo, contrasena: u.contrasena }),
      });
      expect.soft({ status: l.status, body: l.body }, `login · ${etq}`).toEqual({ status: 403, body: { codigo: "origen_invalido" } });
      expect.soft(l.setCookie.length, `login · ${etq}: sin Set-Cookie`).toBe(0);
    }
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).status, "la sesión sobrevive").toBe(200);

    // Controles positivos: same-origin con Origin correcto, y same-origin sin Origin.
    const okLogin = await h.login(u.correo, u.contrasena, { origen: null, secFetchSite: "same-origin", ip: ip() });
    expect(okLogin.status).toBe(200);
    const ok = await h.pedir({ ruta: "/auth/logout", cuerpo: {}, cookie: s.cookie, csrf: s.csrf, secFetchSite: "same-origin", ip: ip() });
    expect(ok.status).toBe(204);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).status).toBe(401);
  });
});

describe("r2a · B1: restablecer limitado por IP y sin Argon2 con tokens inválidos", () => {
  it("10 tokens inventados = 0 Argon2; el 11.º da 429 aunque el token sea bueno; XFF rotado a la izquierda, /64 IPv6 e IPv4 mapeada no evaden", async () => {
    const u = await h.crearUsuario();
    sujetos.push(claveCorreo(u.correo).toString("hex"));
    expect((await recuperar(u.correo)).status).toBe(202);
    await h.correo.esperar(normalizar(u.correo), 1);
    const [bueno] = tokensDe(u.correo);

    const octeto = () => 1 + ((randomBytes(1)[0] ?? 0) % 250);
    const g = () => (0x1000 + (randomBytes(2).readUInt16BE(0) % 0xe000)).toString(16);
    const v4 = ip();
    const v4b = ip();
    const p6 = `2001:db8:${g()}:${g()}`;
    prefijos6.push(p6);
    const mapeada = ip();
    // Cada variante: 11 identidades de red que el servidor (TRUST_PROXY=loopback) debe ver como la misma IP.
    const variantes: [string, (i: number) => string][] = [
      ["misma IPv4", () => v4],
      ["XFF con entradas falsas a la izquierda", (i) => `203.0.113.${octeto()}, 198.51.100.${i + 1}, ${v4b}`],
      ["IPv6 rotada dentro del /64", () => `${p6}:${g()}:${g()}:${g()}:${g()}`],
      ["IPv4 y su forma mapeada en IPv6", (i) => (i % 2 ? `::ffff:${mapeada}` : mapeada)],
    ];
    for (const [etq, xff] of variantes) {
      const antes = h.hasher.calculos;
      const estados: number[] = [];
      for (let i = 0; i < 10; i++) estados.push((await restablecer(tokenInventado(), nueva("b1"), xff(i))).status);
      expect.soft(estados, `${etq}: 10 primeros`).toEqual(Array(10).fill(400));
      expect.soft(h.hasher.calculos - antes, `${etq}: Argon2 con tokens inventados`).toBe(0);
      const once = await restablecer(bueno!, nueva("b1-bueno"), xff(10));
      expect.soft(formaS(once), `${etq}: 11.º con token bueno`).toEqual({ status: 429, body: { codigo: "demasiados_intentos" } });
    }
    // El 429 no tuvo efectos: el token sigue vivo y sirve desde otra IP.
    const desdeOtra = await restablecer(bueno!, nueva("b1-fin"));
    expect(desdeOtra.status).toBe(204);
  });
});

describe("r2a · B2: el contador de intentos en /auth/contrasena", () => {
  it("cambios correctos no bloquean; 4 fallos + un éxito reinician; 5 fallos seguidos bloquean (misma respuesta) y la cuenta no entra", async () => {
    const u = await h.crearUsuario();
    let actual = u.contrasena;
    const ses = await h.entrar(u, { ip: ip() });
    let cookie = ses.cookie;
    let csrf = ses.csrf;
    const fila = async () =>
      (await h.sql("select fallos, bloqueado_hasta is not null as bloqueada from auth.intento_login where clave = $1", [claveCorreo(u.correo)]))[0] ?? {
        fallos: 0,
        bloqueada: false,
      };
    const cambiar = (act: string, nva: string) =>
      h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: act, nueva: nva }, cookie, csrf, ip: ip() });
    const exito = async (etq: string) => {
      const nva = nueva(etq);
      const r = await cambiar(actual, nva);
      expect(r.status, `cambio correcto ${etq}`).toBe(204);
      cookie = cookieDe(r);
      csrf = await csrfDe(cookie);
      actual = nva;
    };
    const fallo = () => cambiar(`${actual}-mal`, nueva("f"));

    for (let i = 0; i < 6; i++) await exito(`ok${i}`);
    expect(await fila(), "6 cambios correctos").toMatchObject({ fallos: 0, bloqueada: false });

    const primeros: Resp[] = [];
    for (let i = 0; i < 4; i++) primeros.push(await fallo());
    expect(primeros.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(await fila()).toMatchObject({ fallos: 4, bloqueada: false });
    await exito("reinicio");
    expect(await fila(), "un éxito reinicia").toMatchObject({ fallos: 0, bloqueada: false });

    const cinco: Resp[] = [];
    for (let i = 0; i < 5; i++) cinco.push(await fallo());
    expect(await fila(), "5.º fallo").toMatchObject({ bloqueada: true });
    for (const r of cinco) expect.soft(formaS(r), "misma respuesta antes y en el bloqueo").toEqual(formaS(primeros[0]!));
    const conBuena = await cambiar(actual, nueva("bloq"));
    expect.soft(conBuena.status, "cambiar con la actual correcta estando bloqueada").toBe(401);
    expect((await h.login(u.correo, actual, { ip: ip() })).status, "login con la contraseña vigente estando bloqueada").toBe(401);
  });
});

describe("r2a · B3: errores del analizador de cuerpo", () => {
  it("charsets y codificaciones raras, gzip roto o bomba: 4xx con solo {codigo}, nunca 500; el servidor sigue sano", async () => {
    const json = '{"correo":"r2a-b3@t004.contapp.test","contrasena":"Contrasena-cualquiera-1"}';
    const casos: [string, [string, string][], Buffer | string, number | null][] = [
      ["charset=latin1", [["Content-Type", "application/json; charset=latin1"]], json, 415],
      ["charset=iso-8859-1", [["Content-Type", "application/json; charset=ISO-8859-1"]], json, 415],
      ["charset=utf-foo", [["Content-Type", "application/json; charset=utf-foo"]], json, 415],
      ["charset=utf8 (sin guion)", [["Content-Type", "application/json; charset=utf8"]], json, null],
      ["charset entre comillas", [["Content-Type", 'application/json; charset="latin1"']], json, 415],
      ["charset vacío", [["Content-Type", "application/json; charset="]], json, null],
      ["dos charset", [["Content-Type", "application/json; charset=utf-8; charset=latin1"]], json, null],
      ["charset=utf-16le", [["Content-Type", "application/json; charset=utf-16le"]], Buffer.from(json, "utf16le"), null],
      ["charset=utf-7", [["Content-Type", "application/json; charset=utf-7"]], json, null],
      ["Content-Encoding compress", [["Content-Type", "application/json"], ["Content-Encoding", "compress"]], json, 415],
      ["Content-Encoding x-foo", [["Content-Type", "application/json"], ["Content-Encoding", "x-foo"]], json, 415],
      ["Content-Encoding gzip, gzip", [["Content-Type", "application/json"], ["Content-Encoding", "gzip, gzip"]], gzipSync(gzipSync(json)), null],
      ["gzip roto", [["Content-Type", "application/json"], ["Content-Encoding", "gzip"]], randomBytes(64), null],
      ["deflate roto", [["Content-Type", "application/json"], ["Content-Encoding", "deflate"]], randomBytes(64), null],
      ["br roto", [["Content-Type", "application/json"], ["Content-Encoding", "br"]], randomBytes(64), null],
      ["bomba gzip (4 MB descomprimidos)", [["Content-Type", "application/json"], ["Content-Encoding", "gzip"]], gzipSync(`{"correo":"${" ".repeat(4 * 1024 * 1024)}"}`), 413],
    ];
    for (const [etq, cab, cuerpo, esperado] of casos) {
      const r = await crudo({
        ruta: "/auth/login",
        cabeceras: [["Origin", ORIGEN], ["X-Forwarded-For", ip()], ...cab],
        cuerpo,
      });
      expect.soft(r.status, `${etq}: no 500`).toBeLessThan(500);
      expect.soft(r.status, `${etq}: 4xx`).toBeGreaterThanOrEqual(400);
      expect.soft(Object.keys(r.body), `${etq}: cuerpo solo {codigo}`).toEqual(["codigo"]);
      expect.soft(r.texto, `${etq}: sin eco`).not.toMatch(/latin1|utf-foo|compress|x-foo|gzip|deflate|r2a-b3|Contrasena/i);
      if (esperado === 415) expect.soft(r.body, etq).toEqual({ codigo: "solicitud_invalida" });
      if (esperado !== null) expect.soft(r.status, etq).toBe(esperado);
    }
    expect((await h.login(h.correoInexistente(), "Contrasena-cualquiera-1", { ip: ip() })).status, "servidor sano").toBe(401);
  });
});
