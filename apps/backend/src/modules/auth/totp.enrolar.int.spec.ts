// T3 (029) · CA-1 (enrolar y confirmar el TOTP). Rojo: las rutas `/auth/totp/*` y las tablas de 0078 aún no existen (T5, T7).
// El reloj corre solo en `Date` (congelarReloj) para que el borde de ±1 paso no dependa de cuándo se ejecuta la prueba.
import { codigosRecuperacionRespuestaSchema, enrolarTotpRespuestaSchema } from "@contapp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cookieSesion, COOKIE, seedAuth, type Harness } from "../../../test/soporte.js";
import { derivarCsrf } from "./sesion/csrf.js";
import {
  abrirHarnessTotp,
  activarTotp,
  codigoErroneo,
  codigoTotp,
  congelarReloj,
  entrarSinTotp,
  eventos,
  filaTotp,
  FORMATO_CODIGO_RECUPERACION,
  parametrosUri,
  secretoDeUri,
  sesionesDe,
  type Reloj,
} from "../../../test/soporte-totp.js";

let h: Harness;
let reloj: Reloj | null = null;
beforeAll(async () => {
  h = await abrirHarnessTotp();
});
afterAll(async () => {
  await h?.cerrar();
});
afterEach(() => {
  reloj?.liberar();
  reloj = null;
});

const enrolar = (s: { cookie: string; csrf: string }, contrasena: unknown, extra: Record<string, unknown> = {}) =>
  h.pedir({ ruta: "/auth/totp/enrolar", cuerpo: { contrasena }, cookie: s.cookie, csrf: s.csrf, ...extra });
const confirmar = (s: { cookie: string; csrf: string }, codigo: unknown, extra: Record<string, unknown> = {}) =>
  h.pedir({ ruta: "/auth/totp/confirmar", cuerpo: { codigo }, cookie: s.cookie, csrf: s.csrf, ...extra });

describe("CA-1 · enrolar: con la contraseña actual se entrega el secreto una sola vez", () => {
  it("200 { uri } otpauth RFC 6238 (secreto de 20 B, SHA-1, 6 dígitos, 30 s), no-store y nada más en el cuerpo", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const r = await enrolar(s, u.contrasena);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(r.body)).toEqual(["uri"]);
    expect(enrolarTotpRespuestaSchema.safeParse(r.body).success).toBe(true);
    const p = parametrosUri(r.body.uri);
    expect(p.protocolo).toBe("otpauth:");
    expect(p.tipo).toBe("totp");
    expect(p.secreto).toMatch(/^[A-Z2-7]{32}$/); // 20 B en base32 sin relleno
    if (p.algorithm !== null) expect(p.algorithm.toUpperCase()).toBe("SHA1");
    if (p.digits !== null) expect(p.digits).toBe("6");
    if (p.period !== null) expect(p.period).toBe("30");
  });

  it("cada enrolamiento da un secreto distinto y GET /auth/sesion nunca lo devuelve", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const a = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    const b = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    expect(a).not.toBe(b);
    const ses = await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie });
    expect(ses.text).not.toContain(a);
    expect(ses.text).not.toContain(b);
    expect(ses.body.totpActivo).toBe(false);
  });

  it("sin contraseña actual, con una errónea o con otro tipo: no hay secreto ni fila pendiente", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const mala = await enrolar(s, "Contrasena-equivocada-1");
    expect(mala.status).toBe(401);
    expect(mala.body).toEqual({ codigo: "credenciales_invalidas" });
    expect(mala.text).not.toMatch(/otpauth|secret/i);
    for (const cuerpo of [{}, { contrasena: 12345 }, { contrasena: null }, []]) {
      const r = await h.pedir({ ruta: "/auth/totp/enrolar", cuerpo, cookie: s.cookie, csrf: s.csrf });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await filaTotp(h, u.id)).toBeUndefined();
  });

  it("la contraseña mala no deja pasar con el correo de otro: sin sesión 401 y sin CSRF 403", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    expect((await h.pedir({ ruta: "/auth/totp/enrolar", cuerpo: { contrasena: u.contrasena } })).status).toBe(401);
    const sinCsrf = await h.pedir({ ruta: "/auth/totp/enrolar", cuerpo: { contrasena: u.contrasena }, cookie: s.cookie });
    expect(sinCsrf.status).toBe(403);
    expect(sinCsrf.body).toEqual({ codigo: "csrf_invalido" });
    expect(await filaTotp(h, u.id)).toBeUndefined();
  });
});

describe("CA-1 · confirmar: solo un código válido activa el factor", () => {
  it("con el código del paso actual: 200 con 10 códigos de recuperación únicos, no-store, token rotado y sesión verificada", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const otra = await entrarSinTotp(h, u); // otra sesión viva: se revoca al activar (U3)
    const s = await entrarSinTotp(h, u);
    const secreto = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    const r = await confirmar(s, reloj.codigo(secreto));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(r.body)).toEqual(["codigosRecuperacion"]);
    expect(codigosRecuperacionRespuestaSchema.safeParse(r.body).success).toBe(true);
    expect(r.body.codigosRecuperacion).toHaveLength(10);
    expect(new Set(r.body.codigosRecuperacion).size).toBe(10);
    for (const c of r.body.codigosRecuperacion) expect(c).toMatch(FORMATO_CODIGO_RECUPERACION);

    // Token rotado: el anterior ya no vale, el nuevo es `verificado` y el factor consta activo.
    const nueva = cookieSesion(r);
    expect(nueva).toBeDefined();
    expect(nueva!.valor).not.toBe(s.cookie.split("=")[1]);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).status).toBe(401);
    const estado = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${nueva!.valor}` });
    expect(estado.status).toBe(200);
    expect(estado.body.factor).toBe("verificado");
    expect(estado.body.totpActivo).toBe(true);
    // Las demás sesiones se revocan con el motivo `totp`.
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: otra.cookie })).status).toBe(401);
    const filas = await sesionesDe(h, u.id);
    expect(filas.filter((f) => f.revocada_en === null)).toHaveLength(1);
    expect(filas.filter((f) => f.motivo === "totp").length).toBeGreaterThanOrEqual(1);
    expect((await eventos(h, u.id)).map((e) => e.tipo)).toEqual(["totp_activado"]);
  });

  it("un código erróneo da 401 codigo_invalido, no activa y el pendiente sigue vigente para un código bueno", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const secreto = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    const r = await confirmar(s, codigoErroneo(secreto, reloj.ahora()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "codigo_invalido" });
    expect(cookieSesion(r)).toBeUndefined();
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).body.totpActivo).toBe(false);
    expect((await filaTotp(h, u.id))?.activo_cifrado ?? null).toBeNull();
    expect((await confirmar(s, reloj.codigo(secreto))).status).toBe(200);
  });

  it("sin haber enrolado, ningún código activa nada", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const r = await confirmar(s, "123456");
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "codigo_invalido" });
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).body.totpActivo).toBe(false);
  });

  it("un pendiente vencido (10 min) no se confirma ni con el código correcto", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const secreto = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    await h.sql("update auth.totp set pendiente_expira = now() - interval '1 second' where usuario_id = $1", [u.id]);
    const r = await confirmar(s, reloj.codigo(secreto));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "codigo_invalido" });
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).body.totpActivo).toBe(false);
  });

  it("el pendiente caduca a los 10 minutos de enrolar (no antes, no después)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    await enrolar(s, u.contrasena);
    const [f] = await h.sql(
      "select extract(epoch from (pendiente_expira - now())) as seg from auth.totp where usuario_id = $1",
      [u.id],
    );
    expect(Number(f.seg)).toBeGreaterThan(9 * 60);
    expect(Number(f.seg)).toBeLessThanOrEqual(10 * 60);
  });

  it("un pendiente reemplazado no se confirma: solo vale el secreto del último enrolamiento", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const primero = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    const segundo = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    expect(primero).not.toBe(segundo);
    const viejo = await confirmar(s, reloj.codigo(primero));
    expect(viejo.status).toBe(401);
    expect(viejo.body).toEqual({ codigo: "codigo_invalido" });
    expect((await confirmar(s, reloj.codigo(segundo))).status).toBe(200);
  });

  it("acepta ±1 paso y rechaza ±2 (ventana de 029 CA-2 también al confirmar)", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const secreto = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    for (const d of [-2, 2]) expect((await confirmar(s, reloj.codigo(secreto, d))).status).toBe(401);
    expect((await confirmar(s, reloj.codigo(secreto, -1))).status).toBe(200);
  });

  it("un código con formato inválido da 400 solicitud_invalida sin eco y sin tocar el pendiente", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    await enrolar(s, u.contrasena);
    for (const codigo of ["12345", "1234567", " 123456", "12345a", 123456, null, ["123456"], "canario-eco"]) {
      const r = await confirmar(s, codigo);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      expect(r.text).not.toContain("canario-eco");
    }
    expect((await filaTotp(h, u.id))?.pendiente_cifrado).toBeTruthy();
  });

  it("sin sesión 401, sin CSRF 403 y con Origin ajeno 403: nada se activa", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const secreto = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    const codigo = reloj.codigo(secreto);
    expect((await h.pedir({ ruta: "/auth/totp/confirmar", cuerpo: { codigo } })).status).toBe(401);
    const sinCsrf = await h.pedir({ ruta: "/auth/totp/confirmar", cuerpo: { codigo }, cookie: s.cookie });
    expect(sinCsrf.status).toBe(403);
    expect(sinCsrf.body).toEqual({ codigo: "csrf_invalido" });
    const ajeno = await confirmar(s, codigo, { origen: "https://evil.example" });
    expect(ajeno.status).toBe(403);
    expect(ajeno.body).toEqual({ codigo: "origen_invalido" });
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).body.totpActivo).toBe(false);
    expect((await confirmar(s, codigo)).status).toBe(200); // el código seguía sin usarse
  });

  it("dos confirmaciones concurrentes del mismo código: una activa, la otra no emite códigos", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const secreto = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    const codigo = reloj.codigo(secreto);
    const rs = await Promise.all([confirmar(s, codigo), confirmar(s, codigo)]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 200).every((r) => r.status === 401)).toBe(true);
    expect((await eventos(h, u.id)).filter((e) => e.tipo === "totp_activado")).toHaveLength(1);
  });
});

describe("CA-1 · re-enrolar con el TOTP activo exige el código vigente", () => {
  it("con solo la contraseña no se entrega un secreto nuevo y el factor activo sigue igual", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const cuenta = await activarTotp(h, u, reloj);
    const antes = await filaTotp(h, u.id);
    const r = await enrolar(cuenta, u.contrasena);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.text).not.toMatch(/otpauth|secret=/i);
    expect(cookieSesion(r)).toBeUndefined();
    const despues = await filaTotp(h, u.id);
    expect(despues.activo_cifrado).toEqual(antes.activo_cifrado);
    expect(despues.pendiente_cifrado ?? null).toBeNull();
    // El secreto activo sigue sirviendo: login con TOTP con el paso siguiente.
    reloj.avanzar(1);
    const l = await h.login(u.correo, u.contrasena);
    expect(l.body).toEqual({ segundoFactor: true, estudioActivo: null, csrf: derivarCsrf(cookieSesion(l)!.valor) });
  });

  it("sin sesión `verificado` (otra sesión `sin_factor` de la misma cuenta) tampoco enrola", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [seedAuth().tenantA] });
    const cuenta = await activarTotp(h, u, reloj);
    await h.sql("update auth.sesion set factor = 'sin_factor' where usuario_id = $1 and revocada_en is null", [u.id]);
    const r = await enrolar(cuenta, u.contrasena);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.text).not.toMatch(/otpauth|secret=/i);
  });
});

describe("CA-1 · coherencia con el reloj del servidor", () => {
  it("el código de un instante lejano (±3 pasos) nunca activa", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const secreto = secretoDeUri((await enrolar(s, u.contrasena)).body.uri);
    for (const d of [-3, 3, 100]) expect((await confirmar(s, codigoTotp(secreto, reloj.ahora(), d))).status).toBe(401);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).body.totpActivo).toBe(false);
  });
});
