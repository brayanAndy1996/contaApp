// T3 (029) · CA-2 (login en dos pasos), CA-3 (fuerza bruta) y CA-9 (código de recuperación de un uso). Rojo: `POST /auth/2fa/verificar`, la
// sesión `pendiente` y las funciones de 0078 aún no existen (T5, T7). Reloj: solo `Date` (congelarReloj); cada verificación usa un paso nuevo.
import { loginSegundoFactorRespuestaSchema } from "@contapp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  analizarSetCookie,
  claveCorreo,
  COOKIE,
  cookieSesion,
  forma,
  maxAge,
  nombreTenant,
  seedAuth,
  type Harness,
} from "../../../test/soporte.js";
import {
  abrirHarnessTotp,
  activarTotp,
  codigoErroneo,
  congelarReloj,
  contadorFallos,
  entrarConTotp,
  eventos,
  loginPendiente,
  sesionDeCookie,
  sesionesDe,
  verificar,
  type CuentaTotp,
  type Reloj,
} from "../../../test/soporte-totp.js";

let h: Harness;
let reloj: Reloj;
beforeAll(async () => {
  h = await abrirHarnessTotp();
});
afterAll(async () => {
  await h?.cerrar();
});
afterEach(() => reloj?.liberar());

/** Usuario con TOTP activo y reloj congelado (el paso de activación ya quedó usado). */
async function conTotp(estudios: string[] = []): Promise<{ u: { id: string; correo: string; contrasena: string }; cuenta: CuentaTotp }> {
  reloj = congelarReloj();
  const u = await h.crearUsuario({ estudios });
  const cuenta = await activarTotp(h, u, reloj);
  return { u, cuenta };
}

describe("CA-2 · el login con TOTP crea una sesión pendiente", () => {
  it("200 { segundoFactor: true, estudioActivo: null }, cookie nueva (≤ 5 min), no-store y en BD factor pendiente sin estudio", async () => {
    const { u } = await conTotp([seedAuth().tenantA]);
    const antes = (await sesionesDe(h, u.id)).length;
    const r = await h.login(u.correo, u.contrasena);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ segundoFactor: true, estudioActivo: null });
    expect(loginSegundoFactorRespuestaSchema.safeParse(r.body).success).toBe(true);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const c = cookieSesion(r);
    expect(c).toBeDefined();
    expect(maxAge(c!)).toBeLessThanOrEqual(300);
    expect(maxAge(c!)).toBeGreaterThan(0);
    const filas = await sesionesDe(h, u.id);
    expect(filas).toHaveLength(antes + 1);
    const p = filas.find((f) => f.factor === "pendiente");
    expect(p).toBeDefined();
    expect(p.tenant_activo).toBeNull(); // un solo estudio, pero la pendiente no elige
    const [vida] = await h.sql(
      "select extract(epoch from (expira_absoluta - creada_en)) as seg from auth.sesion where id = $1",
      [p.id],
    );
    expect(Number(vida.seg)).toBeLessThanOrEqual(300);
    expect(Number(vida.seg)).toBeGreaterThan(240);
  });

  it("sin TOTP el login no cambia: mismo cuerpo de 004 y sesión sin_factor", async () => {
    const u = await h.crearUsuario({ estudios: [seedAuth().tenantA] });
    const r = await h.login(u.correo, u.contrasena);
    expect(r.body).toEqual({ estudioActivo: { id: seedAuth().tenantA, nombre: nombreTenant(seedAuth().tenantA) }, requiereEstudio: false });
    expect((await sesionesDe(h, u.id))[0].factor).toBe("sin_factor");
  });

  it("contraseña errónea y cuenta bloqueada de un usuario con TOTP responden igual que un correo inexistente (como 004 CA-2)", async () => {
    const { u } = await conTotp();
    const bloqueado = await h.crearUsuario({ estudios: [] });
    await activarTotp(h, bloqueado, reloj);
    for (let i = 0; i < 5; i++) await h.login(bloqueado.correo, `incorrecta-${i}-Zz`);
    const base = await h.login(h.correoInexistente(), "Contrasena-cualquiera-1");
    const mala = await h.login(u.correo, "Contrasena-equivocada-1");
    const bloq = await h.login(bloqueado.correo, bloqueado.contrasena);
    expect(base.status).toBe(401);
    expect(base.body).toEqual({ codigo: "credenciales_invalidas" });
    expect(forma(mala)).toEqual(forma(base));
    expect(forma(bloq)).toEqual(forma(base));
    for (const r of [mala, bloq]) expect(r.setCookies).toEqual([]);
  });
});

describe("CA-2 · la sesión pendiente solo sirve para verificar o salir", () => {
  const RUTAS: ReadonlyArray<readonly ["GET" | "POST", string, unknown]> = [
    ["GET", "/auth/sesion", undefined],
    ["GET", "/auth/estudios", undefined],
    ["POST", "/auth/estudio", { tenantId: seedAuth().tenantA }],
    ["POST", "/auth/contrasena", { actual: "x", nueva: "y" }],
    ["POST", "/auth/sesiones/cerrar-todas", {}],
    ["POST", "/auth/totp/enrolar", { contrasena: "x" }],
    ["POST", "/auth/totp/confirmar", { codigo: "123456" }],
    ["POST", "/auth/totp/desactivar", { contrasena: "x", codigo: "123456" }],
    ["POST", "/auth/totp/recuperacion", { contrasena: "x", codigo: "123456" }],
    ["GET", "/auth/sesiones", undefined],
    ["POST", "/auth/sesiones/revocar-otras", {}],
    ["POST", "/auth/sesiones/0190a000-0000-7000-8000-0000000000aa/revocar", {}],
    ["GET", "/estudio/actual", undefined],
    ["GET", "/clientes", undefined],
    ["GET", "/plataforma/yo", undefined],
  ];

  it.each(RUTAS)("%s %s da 401 con la pendiente (también con X-Estudio) y no cambia nada", async (metodo, ruta, cuerpo) => {
    const { u } = await conTotp([seedAuth().tenantA]);
    const p = await loginPendiente(h, u);
    const antes = await sesionesDe(h, u.id);
    const r = await h.pedir({ metodo, ruta, cuerpo, cookie: p.cookie, csrf: p.csrf, estudio: seedAuth().tenantA });
    expect(r.status, `${metodo} ${ruta}: ${JSON.stringify(r.body)}`).toBe(401);
    expect(cookieSesion(r)).toBeUndefined();
    const despues = await sesionesDe(h, u.id);
    expect(despues.map((f) => [f.id, f.factor, f.revocada_en, f.tenant_activo])).toEqual(
      antes.map((f) => [f.id, f.factor, f.revocada_en, f.tenant_activo]),
    );
  });

  it("la pendiente puede salir: logout la revoca y ya no verifica", async () => {
    const { u, cuenta } = await conTotp();
    const p = await loginPendiente(h, u);
    const out = await h.pedir({ ruta: "/auth/logout", cuerpo: {}, cookie: p.cookie, csrf: p.csrf });
    expect(out.status).toBe(204);
    reloj.avanzar(1);
    const r = await verificar(h, p, { codigo: reloj.codigo(cuenta.secreto) });
    expect(r.status).toBe(401);
    expect((await sesionesDe(h, u.id)).find((f) => f.factor === "pendiente").revocada_en).not.toBeNull();
  });

  it("una pendiente vencida (5 min) ya no verifica ni con el código correcto", async () => {
    const { u, cuenta } = await conTotp();
    const p = await loginPendiente(h, u);
    await h.sql("update auth.sesion set expira_absoluta = now() - interval '1 second' where usuario_id = $1 and factor = 'pendiente'", [u.id]);
    reloj.avanzar(1);
    const r = await verificar(h, p, { codigo: reloj.codigo(cuenta.secreto) });
    expect(r.status).toBe(401);
    expect(cookieSesion(r)).toBeUndefined();
  });

  it("verificar sin cookie o con una sesión ya verificada da 401 y no consume el código", async () => {
    const { u, cuenta } = await conTotp();
    reloj.avanzar(1);
    const codigo = reloj.codigo(cuenta.secreto);
    expect((await h.pedir({ ruta: "/auth/2fa/verificar", cuerpo: { codigo } })).status).toBe(401);
    const ya = await verificar(h, cuenta, { codigo }); // `cuenta` es una sesión `verificado`
    expect(ya.status).toBe(401);
    const p = await loginPendiente(h, u);
    expect((await verificar(h, p, { codigo })).status).toBe(200); // el código seguía sin usarse
  });
});

describe("CA-2 · verificar con el código TOTP", () => {
  it("200 como el login de 004 (un estudio: queda activo), token rotado, sesión verificada y la pendiente muere", async () => {
    const { u, cuenta } = await conTotp([seedAuth().tenantA]);
    const p = await loginPendiente(h, u);
    reloj.avanzar(1);
    const r = await verificar(h, p, { codigo: reloj.codigo(cuenta.secreto) });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body).toEqual({ estudioActivo: { id: seedAuth().tenantA, nombre: nombreTenant(seedAuth().tenantA) }, requiereEstudio: false });
    const c = cookieSesion(r)!;
    expect(c.nombre).toBe(COOKIE);
    expect(c.valor).not.toBe(p.valor);
    const attrs = c.atributos.map((a) => a.toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/"]));
    expect(maxAge(c)).toBeGreaterThan(43_000); // vida de una sesión plena (12 h), no los 5 min de la pendiente
    expect(maxAge(c)).toBeLessThanOrEqual(43_200);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: p.cookie })).status).toBe(401); // token anterior muerto
    const s = await sesionDeCookie(h, c.valor);
    const estado = await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie });
    expect(estado.body).toMatchObject({ factor: "verificado", totpActivo: true });
    expect(estado.body.estudioActivo.id).toBe(seedAuth().tenantA);
  });

  it("con varios estudios entra sin estudio activo y pide elegir (como P7 de 004)", async () => {
    const { u, cuenta } = await conTotp([seedAuth().tenantA, seedAuth().tenantB]);
    const p = await loginPendiente(h, u);
    reloj.avanzar(1);
    const r = await verificar(h, p, { codigo: reloj.codigo(cuenta.secreto) });
    expect(r.body).toEqual({ estudioActivo: null, requiereEstudio: true });
  });

  it("acepta ±1 paso del reloj del servidor y rechaza ±2; el código erróneo es 401 codigo_invalido sin cookie", async () => {
    const { u, cuenta } = await conTotp();
    const casos: Array<[number, number]> = [
      [-2, 401],
      [2, 401],
      [-1, 200],
    ];
    for (const [d, esperado] of casos) {
      reloj.avanzar(1);
      const p = await loginPendiente(h, u);
      const r = await verificar(h, p, { codigo: reloj.codigo(cuenta.secreto, d) });
      expect(r.status, `desfase ${d}`).toBe(esperado);
      if (esperado === 401) {
        expect(r.body).toEqual({ codigo: "codigo_invalido" });
        expect(cookieSesion(r)).toBeUndefined();
      }
    }
    // +1 (el reloj del cliente adelantado): vale en el paso siguiente al último aceptado.
    reloj.avanzar(2);
    const p2 = await loginPendiente(h, u);
    expect((await verificar(h, p2, { codigo: reloj.codigo(cuenta.secreto, 1) })).status).toBe(200);
  });

  it("replay: un código de un paso ya usado se rechaza, también con otra sesión pendiente y con un paso anterior", async () => {
    const { u, cuenta } = await conTotp();
    reloj.avanzar(1);
    const codigo = reloj.codigo(cuenta.secreto);
    const a = await loginPendiente(h, u);
    expect((await verificar(h, a, { codigo })).status).toBe(200);
    const b = await loginPendiente(h, u);
    const r = await verificar(h, b, { codigo });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "codigo_invalido" });
    // Un paso anterior al último aceptado (aún dentro de la ventana) tampoco vale.
    const c = await loginPendiente(h, u);
    expect((await verificar(h, c, { codigo: reloj.codigo(cuenta.secreto, -1) })).status).toBe(401);
  });

  it("dos verificaciones concurrentes del mismo código: solo una pasa", async () => {
    const { u, cuenta } = await conTotp();
    const [a, b] = [await loginPendiente(h, u), await loginPendiente(h, u)];
    reloj.avanzar(1);
    const codigo = reloj.codigo(cuenta.secreto);
    const rs = await Promise.all([verificar(h, a, { codigo }), verificar(h, b, { codigo })]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const otra = rs.find((r) => r.status !== 200)!;
    expect(otra.status).toBe(401);
    expect(cookieSesion(otra)).toBeUndefined();
  });

  it("cuerpo inválido: 400 solicitud_invalida sin eco, sin Set-Cookie y sin sumar intentos", async () => {
    const { u, cuenta } = await conTotp();
    const p = await loginPendiente(h, u);
    const antes = await contadorFallos(h, claveCorreo(u.correo));
    const cuerpos: unknown[] = [
      {},
      { codigo: "12345" },
      { codigo: 123456 },
      { codigoRecuperacion: "ABCD-EFGH" },
      { codigoRecuperacion: "abcd-efgh-2345" },
      { codigo: "123456", codigoRecuperacion: "ABCD-EFGH-2345" }, // exactamente uno
      { codigo: "123456", extra: "canario-eco" },
      { codigo: "canario-eco" },
    ];
    for (const c of cuerpos) {
      const r = await verificar(h, p, c);
      expect(r.status, JSON.stringify(c)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      expect(r.text).not.toContain("canario-eco");
      expect(r.setCookies).toEqual([]);
    }
    expect(await contadorFallos(h, claveCorreo(u.correo))).toEqual(antes);
    reloj.avanzar(1);
    expect((await verificar(h, p, { codigo: reloj.codigo(cuenta.secreto) })).status).toBe(200); // la pendiente seguía viva
  });

  it("Origin ajeno o sin CSRF: 403 y el código no se consume", async () => {
    const { u, cuenta } = await conTotp();
    const p = await loginPendiente(h, u);
    reloj.avanzar(1);
    const codigo = reloj.codigo(cuenta.secreto);
    const ajeno = await verificar(h, p, { codigo }, { origen: "https://evil.example" });
    expect(ajeno.status).toBe(403);
    expect(ajeno.body).toEqual({ codigo: "origen_invalido" });
    const sinCsrf = await verificar(h, { cookie: p.cookie, csrf: "x".repeat(43) }, { codigo });
    expect(sinCsrf.status).toBe(403);
    expect(sinCsrf.body).toEqual({ codigo: "csrf_invalido" });
    expect((await verificar(h, p, { codigo })).status).toBe(200);
  });

  it("restablecer la contraseña por el correo no salta el TOTP: el siguiente login sigue pidiendo el segundo paso", async () => {
    const { u, cuenta } = await conTotp();
    const nueva = "Contrasena-nueva-029-qWz";
    await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo } });
    await h.correo.esperar(u.correo, 1);
    const rest = await h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token: h.correo.tokenDe(u.correo), contrasena: nueva } });
    expect(rest.status).toBe(204);
    expect(cookieSesion(rest)).toBeUndefined();
    expect((await sesionesDe(h, u.id)).filter((f) => f.revocada_en === null)).toHaveLength(0);
    const l = await h.login(u.correo, nueva);
    expect(l.body).toEqual({ segundoFactor: true, estudioActivo: null });
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${cookieSesion(l)!.valor}` })).status).toBe(401);
    reloj.avanzar(1);
    expect((await verificar(h, await loginPendiente(h, { correo: u.correo, contrasena: nueva }), { codigo: reloj.codigo(cuenta.secreto) })).status).toBe(200);
  });
});

describe("CA-3 · fuerza bruta: cada código erróneo suma al contador de 004 D7", () => {
  it("al 5.º erróneo la cuenta se bloquea 15 min, la pendiente se revoca y ni la contraseña ni el código buenos entran", async () => {
    const { u, cuenta } = await conTotp();
    const p = await loginPendiente(h, u);
    for (let i = 0; i < 4; i++) {
      const r = await verificar(h, p, { codigo: codigoErroneo(cuenta.secreto, reloj.ahora()) });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ codigo: "codigo_invalido" });
    }
    const quinto = await verificar(h, p, { codigo: codigoErroneo(cuenta.secreto, reloj.ahora()) });
    expect([401, 429]).toContain(quinto.status);
    expect(cookieSesion(quinto)).toBeUndefined();
    const fila = await contadorFallos(h, claveCorreo(u.correo));
    expect(fila?.fallos).toBe(5);
    const [min] = await h.sql(
      "select extract(epoch from (bloqueado_hasta - now())) as seg from auth.intento_login where clave = $1",
      [claveCorreo(u.correo)],
    );
    expect(Number(min.seg)).toBeGreaterThan(14 * 60);
    expect(Number(min.seg)).toBeLessThanOrEqual(15 * 60);
    expect((await sesionesDe(h, u.id)).find((f) => f.factor === "pendiente").revocada_en).not.toBeNull();
    // La pendiente ya no sirve ni con el código bueno, y el login con la contraseña buena se rechaza como cuenta bloqueada.
    reloj.avanzar(1);
    expect((await verificar(h, p, { codigo: reloj.codigo(cuenta.secreto) })).status).toBe(401);
    const login = await h.login(u.correo, u.contrasena);
    expect(login.status).toBe(401);
    expect(login.body).toEqual({ codigo: "credenciales_invalidas" });
  });

  it("el contador es el mismo de la contraseña: 3 contraseñas malas + 2 códigos malos bloquean", async () => {
    const { u, cuenta } = await conTotp();
    const p = await loginPendiente(h, u); // el login bueno reinicia el contador; los fallos se suman después
    for (let i = 0; i < 3; i++) await h.login(u.correo, `incorrecta-${i}-Zz`);
    expect((await contadorFallos(h, claveCorreo(u.correo)))?.fallos).toBe(3);
    for (let i = 0; i < 2; i++) await verificar(h, p, { codigo: codigoErroneo(cuenta.secreto, reloj.ahora()) });
    const fila = await contadorFallos(h, claveCorreo(u.correo));
    expect(fila?.fallos).toBe(5);
    expect(fila?.bloqueado_hasta).not.toBeNull();
  });

  it("un código bueno reinicia el contador: 4 malos, uno bueno y otros 4 malos no bloquean", async () => {
    const { u, cuenta } = await conTotp();
    const p = await loginPendiente(h, u);
    for (let i = 0; i < 4; i++) await verificar(h, p, { codigo: codigoErroneo(cuenta.secreto, reloj.ahora()) });
    reloj.avanzar(1);
    expect((await verificar(h, p, { codigo: reloj.codigo(cuenta.secreto) })).status).toBe(200);
    const fila = await contadorFallos(h, claveCorreo(u.correo));
    expect(fila?.fallos ?? 0).toBe(0);
    reloj.avanzar(1);
    const q = await loginPendiente(h, u);
    for (let i = 0; i < 4; i++) expect((await verificar(h, q, { codigo: codigoErroneo(cuenta.secreto, reloj.ahora()) })).status).toBe(401);
    reloj.avanzar(1);
    expect((await verificar(h, q, { codigo: reloj.codigo(cuenta.secreto) })).status).toBe(200); // no está bloqueada
  });

  it("20 intentos erróneos concurrentes (20 sesiones pendientes) evalúan como máximo 5 y bloquean; después ni el código bueno pasa", async () => {
    const { u, cuenta } = await conTotp();
    const pendientes = [];
    for (let i = 0; i < 20; i++) pendientes.push(await loginPendiente(h, u));
    await h.reiniciarIntentos(u.correo); // los 20 logins buenos ya reiniciaron el contador; parte de cero
    const rs = await Promise.all(pendientes.map((p) => verificar(h, p, { codigo: codigoErroneo(cuenta.secreto, reloj.ahora()) })));
    const evaluados = rs.filter((r) => r.body?.codigo === "codigo_invalido");
    expect(evaluados.length).toBeLessThanOrEqual(5);
    expect(rs.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    expect(rs.every((r) => r.status !== 200)).toBe(true);
    const fila = await contadorFallos(h, claveCorreo(u.correo));
    expect(fila?.fallos).toBe(5);
    expect(fila?.bloqueado_hasta).not.toBeNull();
    reloj.avanzar(1);
    const ok = await Promise.all(pendientes.slice(0, 5).map((p) => verificar(h, p, { codigo: reloj.codigo(cuenta.secreto) })));
    expect(ok.every((r) => r.status !== 200)).toBe(true);
  });

  it("20 códigos concurrentes con el bueno incluido: nunca más de una sesión verificada y como máximo 5 evaluaciones erróneas", async () => {
    const { u, cuenta } = await conTotp();
    const pendientes = [];
    for (let i = 0; i < 20; i++) pendientes.push(await loginPendiente(h, u));
    await h.reiniciarIntentos(u.correo);
    reloj.avanzar(1);
    const bueno = reloj.codigo(cuenta.secreto);
    const rs = await Promise.all(
      pendientes.map((p, i) => verificar(h, p, { codigo: i === 10 ? bueno : codigoErroneo(cuenta.secreto, reloj.ahora()) })),
    );
    expect(rs.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(rs.filter((r) => r.body?.codigo === "codigo_invalido").length).toBeLessThanOrEqual(5);
  });
});

describe("CA-9 · código de recuperación: un uso", () => {
  it("sirve una vez como segundo paso (200, sesión verificada, evento y aviso); la segunda vez es 401 codigo_invalido", async () => {
    const { u, cuenta } = await conTotp();
    const codigo = cuenta.codigos[0]!;
    const a = await loginPendiente(h, u);
    const r = await verificar(h, a, { codigoRecuperacion: codigo });
    expect(r.status).toBe(200);
    expect(cookieSesion(r)).toBeDefined();
    expect(cookieSesion(r)!.valor).not.toBe(a.valor);
    const estado = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${cookieSesion(r)!.valor}` });
    expect(estado.body.factor).toBe("verificado");
    expect((await eventos(h, u.id)).map((e) => e.tipo)).toContain("recuperacion_usada");
    expect((await h.correo.esperar(u.correo, 2)).length).toBeGreaterThanOrEqual(2); // activación + uso de recuperación (U8)
    const b = await loginPendiente(h, u);
    const otra = await verificar(h, b, { codigoRecuperacion: codigo });
    expect(otra.status).toBe(401);
    expect(otra.body).toEqual({ codigo: "codigo_invalido" });
    expect(cookieSesion(otra)).toBeUndefined();
  });

  it("dos usos concurrentes del mismo código de recuperación: solo uno pasa", async () => {
    const { u, cuenta } = await conTotp();
    const codigo = cuenta.codigos[1]!;
    const [a, b] = [await loginPendiente(h, u), await loginPendiente(h, u)];
    const rs = await Promise.all([verificar(h, a, { codigoRecuperacion: codigo }), verificar(h, b, { codigoRecuperacion: codigo })]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 401)).toHaveLength(1);
    expect((await eventos(h, u.id)).filter((e) => e.tipo === "recuperacion_usada")).toHaveLength(1);
  });

  it("un código de recuperación erróneo suma al contador y no gasta ninguno bueno", async () => {
    const { u, cuenta } = await conTotp();
    const p = await loginPendiente(h, u);
    const falso = "AAAA-AAAA-AAAA";
    expect(cuenta.codigos).not.toContain(falso);
    const r = await verificar(h, p, { codigoRecuperacion: falso });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "codigo_invalido" });
    expect((await contadorFallos(h, claveCorreo(u.correo)))?.fallos).toBe(1);
    expect((await verificar(h, p, { codigoRecuperacion: cuenta.codigos[2]! })).status).toBe(200);
  });

  it("el código de recuperación de otra cuenta no sirve", async () => {
    const { u } = await conTotp();
    const ajena = await h.crearUsuario({ estudios: [] });
    const otra = await activarTotp(h, ajena, reloj);
    const p = await loginPendiente(h, u);
    const r = await verificar(h, p, { codigoRecuperacion: otra.codigos[0]! });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "codigo_invalido" });
  });
});

describe("CA-2 · el segundo paso no abre otras puertas", () => {
  it("una sesión verificada por TOTP rota al elegir estudio y conserva su factor", async () => {
    const { u, cuenta } = await conTotp([seedAuth().tenantA, seedAuth().tenantB]);
    const s = await entrarConTotp(h, u, cuenta.secreto, reloj);
    const r = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seedAuth().tenantB }, cookie: s.cookie, csrf: s.csrf });
    expect(r.status).toBe(200);
    const nueva = analizarSetCookie(r.setCookies[0]!);
    const estado = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${nueva.valor}` });
    expect(estado.body.factor).toBe("verificado");
    expect(estado.body.estudioActivo.id).toBe(seedAuth().tenantB);
  });
});
