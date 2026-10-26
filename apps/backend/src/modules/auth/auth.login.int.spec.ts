// T7 (004) · CA-1, CA-2, CA-4 (parte de login) y P7. Rojo: `crearApp` aun no existe (T12).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  COOKIE,
  PWD,
  analizarSetCookie,
  atributo,
  claveCorreo,
  correoSeed,
  cookieSesion,
  esHashDe,
  forma,
  hashViejo,
  maxAge,
  nombreTenant,
  seedAuth,
  type Harness,
} from "../../../test/soporte.js";

let h: Harness;
beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  await h?.cerrar();
});

describe("CA-1 · login correcto", () => {
  it("responde 200, emite la cookie de D5 y en BD solo queda el hash del token", async () => {
    const u = await h.crearUsuario({ estudios: [seedAuth().tenantA] });
    const r = await h.login(u.correo, u.contrasena);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);

    expect(r.setCookies).toHaveLength(1);
    const c = cookieSesion(r);
    expect(c).toBeDefined();
    expect(c!.valor).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 B en base64url
    const attrs = c!.atributos.map((a) => a.toLowerCase());
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("secure");
    expect(attrs).toContain("samesite=lax");
    expect(attrs).toContain("path=/");
    expect(attrs.some((a) => a.startsWith("domain"))).toBe(false);
    expect(maxAge(c!)).toBeGreaterThan(43_000);
    expect(maxAge(c!)).toBeLessThanOrEqual(43_200); // 12 h absolutas (D3)

    const filas = await h.sesiones(u.id);
    expect(filas).toHaveLength(1);
    expect(esHashDe(filas[0].token_hash, c!.valor)).toBe(true);
    // El token en claro no está en ninguna columna de la sesión.
    const crudo = await h.sql("select count(*)::int as n from auth.sesion s where s::text like '%' || $1 || '%'", [c!.valor]);
    expect(crudo[0].n).toBe(0);
  });

  it("con un solo estudio queda activo en el login (P7)", async () => {
    const u = await h.crearUsuario({ estudios: [seedAuth().tenantA] });
    const r = await h.login(u.correo, u.contrasena);
    expect(r.body).toEqual({
      estudioActivo: { id: seedAuth().tenantA, nombre: nombreTenant(seedAuth().tenantA) },
      requiereEstudio: false,
    });
    const s = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${cookieSesion(r)!.valor}` });
    expect(s.body.estudioActivo).toEqual({ id: seedAuth().tenantA, nombre: nombreTenant(seedAuth().tenantA) });
  });

  it("con varios estudios entra sin estudio activo y pide elegir (P7)", async () => {
    const u = await h.crearUsuario({ estudios: [seedAuth().tenantA, seedAuth().tenantB] });
    const r = await h.login(u.correo, u.contrasena);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estudioActivo: null, requiereEstudio: true });
  });

  it("sin estudios entra sin estudio activo y la lista de estudios es vacía (P7)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    expect(s.estudioActivo).toBeNull();
    const l = await h.pedir({ ruta: "/auth/estudios", cookie: s.cookie });
    expect(l.status).toBe(200);
    expect(l.body).toEqual([]);
  });

  it("con los usuarios del seed: uA entra con estudio, uAB y uSin sin estudio", async () => {
    const seed = seedAuth();
    const a = await h.login(correoSeed(seed.uA), seed.contrasenaDesarrollo);
    expect(a.status).toBe(200);
    expect(a.body.estudioActivo).toEqual({ id: seed.tenantA, nombre: nombreTenant(seed.tenantA) });
    const ab = await h.login(correoSeed(seed.uAB), seed.contrasenaDesarrollo);
    expect(ab.status).toBe(200);
    expect(ab.body.estudioActivo).toBeNull();
    expect(ab.body.requiereEstudio).toBe(true);
    const sin = await h.entrar({ correo: correoSeed(seed.uSin), contrasena: seed.contrasenaDesarrollo });
    expect(sin.estudioActivo).toBeNull();
    const lista = await h.pedir({ ruta: "/auth/estudios", cookie: sin.cookie });
    expect(lista.body).toEqual([]);
  });

  it("normaliza el correo (mayúsculas y espacios) antes de buscar", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const r = await h.login(`  ${u.correo.toUpperCase()}  `, u.contrasena);
    expect(r.status).toBe(200);
  });

  it("GET /auth/sesion devuelve usuario, estudio activo y csrf, sin hash ni token", async () => {
    const u = await h.crearUsuario({ estudios: [seedAuth().tenantA] });
    const s = await h.entrar(u);
    const r = await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie });
    expect(r.status).toBe(200);
    expect(r.body.usuario).toEqual({ id: u.id, nombre: "Usuario de prueba 004", correo: u.correo });
    expect(typeof r.body.csrf).toBe("string");
    expect(r.body.csrf.length).toBeGreaterThanOrEqual(32);
    expect(r.body.csrf).not.toBe(s.valor);
    expect(Object.keys(r.body).sort()).toEqual(["csrf", "estudioActivo", "usuario"]);
    expect(r.text).not.toContain(s.valor);
  });

  it("sin cookie GET /auth/sesion da 401 sesion_invalida", async () => {
    const r = await h.pedir({ ruta: "/auth/sesion" });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "sesion_invalida" });
  });
});

describe("CA-2 · respuesta única", () => {
  async function ramas() {
    const real = await h.crearUsuario({ estudios: [] });
    const bloqueado = await h.crearUsuario({ estudios: [] });
    for (let i = 0; i < 5; i++) await h.login(bloqueado.correo, "incorrecta-" + i);
    return { real, bloqueado, inexistente: h.correoInexistente() };
  }

  it("inexistente, contraseña errónea y cuenta bloqueada dan el mismo código, cuerpo y cabeceras, sin Set-Cookie", async () => {
    const { real, bloqueado, inexistente } = await ramas();
    const a = await h.login(inexistente, "Contrasena-cualquiera-1");
    const b = await h.login(real.correo, "Contrasena-equivocada-1");
    const c = await h.login(bloqueado.correo, bloqueado.contrasena); // la correcta también se rechaza
    expect(a.status).toBe(401);
    expect(a.body).toEqual({ codigo: "credenciales_invalidas" });
    expect(forma(b)).toEqual(forma(a));
    expect(forma(c)).toEqual(forma(a));
    for (const r of [a, b, c]) {
      expect(r.setCookies).toEqual([]);
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("una sola verificación Argon2id por rama: ficticia si no hay hash utilizable, real si lo hay", async () => {
    const { real, bloqueado, inexistente } = await ramas();

    let m = h.hasher.marca();
    await h.login(inexistente, "Contrasena-cualquiera-1");
    expect(h.hasher.ficticias - m.ficticias).toBe(1); // correo inexistente → hash ficticio (D9)
    expect(h.hasher.reales - m.reales).toBe(0);

    m = h.hasher.marca();
    await h.login(real.correo, "Contrasena-equivocada-1");
    expect(h.hasher.reales - m.reales).toBe(1);
    expect(h.hasher.ficticias - m.ficticias).toBe(0);

    m = h.hasher.marca();
    await h.login(bloqueado.correo, bloqueado.contrasena);
    expect(h.hasher.reales + h.hasher.ficticias - (m.reales + m.ficticias)).toBe(1); // misma ruta de código
  });

  it("las variantes de mayúsculas y espacios del correo existente y del inexistente responden igual", async () => {
    const real = await h.crearUsuario({ estudios: [] });
    const base = await h.login(h.correoInexistente(), "Contrasena-cualquiera-1");
    const v1 = await h.login(` ${real.correo.toUpperCase()} `, "Contrasena-equivocada-1");
    const v2 = await h.login(` ${h.correoInexistente().toUpperCase()}\t`, "Contrasena-equivocada-1");
    expect(forma(v1)).toEqual(forma(base));
    expect(forma(v2)).toEqual(forma(base));
  });

  it("un cuerpo inválido da 400 solicitud_invalida sin eco de la entrada y sin Set-Cookie", async () => {
    const r = await h.pedir({ ruta: "/auth/login", cuerpo: { correo: "canario-eco@t004.contapp.test", contrasena: 12345 } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(r.text).not.toContain("canario-eco");
    expect(r.setCookies).toEqual([]);
  });
});

describe("CA-4 · hash y contraseñas en el login", () => {
  it("un hash con parámetros viejos se re-calcula en el siguiente login válido", async () => {
    const viejo = await hashViejo(PWD);
    const u = await h.crearUsuario({ estudios: [], hash: viejo });
    const antes = h.hasher.rehash;
    const r = await h.login(u.correo, u.contrasena);
    expect(r.status).toBe(200);
    expect(h.hasher.rehash).toBeGreaterThan(antes);
    const [fila] = await h.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]);
    expect(fila.hash).not.toBe(viejo);
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(fila.hash);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(19456);
    expect(Number(m![2])).toBeGreaterThanOrEqual(2);
    expect((await h.login(u.correo, u.contrasena)).status).toBe(200); // el nuevo hash sirve
  });

  it("un hash vigente no se re-calcula", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const [antes] = await h.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]);
    await h.login(u.correo, u.contrasena);
    const [despues] = await h.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]);
    expect(despues.hash).toBe(antes.hash);
  });

  it("una contraseña de más de 128 puntos de código da el 401 genérico sin calcular hash ni contar intento", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const gigante = "😀".repeat(129); // 129 puntos de código (258 unidades UTF-16)
    const base = await h.login(u.correo, "Contrasena-equivocada-1");
    const m = h.hasher.marca();
    const r = await h.login(u.correo, gigante);
    expect(r.status).toBe(401);
    expect(forma(r)).toEqual(forma(base));
    expect(h.hasher.reales + h.hasher.ficticias).toBe(m.reales + m.ficticias);
    // Solo cuenta el intento previo (1 fallo), no el gigante.
    const [fila] = await h.sql("select fallos from auth.intento_login where clave = $1", [claveCorreo(u.correo)]);
    expect(fila.fallos).toBe(1);
  });

  it("un cuerpo JSON de más de 16 kB se rechaza (413) sin procesar", async () => {
    const r = await h.pedir({
      ruta: "/auth/login",
      crudo: JSON.stringify({ correo: "a@t004.contapp.test", contrasena: "x".repeat(20_000) }),
    });
    expect(r.status).toBe(413);
    expect(r.setCookies).toEqual([]);
  });
});

describe("CA-5 · fijación de sesión", () => {
  it("una cookie fijada antes del login nunca se promueve: el login emite un token nuevo", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const fijada = "A".repeat(43);
    const r = await h.login(u.correo, u.contrasena, { cookie: `${COOKIE}=${fijada}` });
    expect(r.status).toBe(200);
    const nueva = cookieSesion(r)!;
    expect(nueva.valor).not.toBe(fijada);
    const antigua = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${fijada}` });
    expect(antigua.status).toBe(401);
  });

  it("un login con una cookie válida previa emite otra distinta y la anterior deja de valer", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s1 = await h.entrar(u);
    const r = await h.login(u.correo, u.contrasena, { cookie: s1.cookie });
    const c2 = analizarSetCookie(r.setCookies[0]!);
    expect(c2.nombre).toBe(COOKIE);
    expect(c2.valor).not.toBe(s1.valor);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s1.cookie })).status).toBe(401);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${c2.valor}` })).status).toBe(200);
  });

  it("la cookie no lleva Domain y el prefijo __Host- exige Path=/ y Secure", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const c = cookieSesion(await h.login(u.correo, u.contrasena))!;
    expect(c.nombre.startsWith("__Host-")).toBe(true);
    expect(atributo(c, "domain")).toBeUndefined();
    expect(atributo(c, "path")?.toLowerCase()).toBe("path=/");
    expect(atributo(c, "secure")).toBeDefined();
  });
});
