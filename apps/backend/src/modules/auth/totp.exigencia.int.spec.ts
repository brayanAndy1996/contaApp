// T3 (029) · CA-4 (exigencia del segundo factor, U1–U3), desactivar con 409 y regenerar códigos (U4, CA-9). Roles de sistema:
// dueno y admin lo exigen; contador, asistente y lectura no (tabla común CASOS_FACTOR_EXIGIDO de T2); el super-admin siempre.
// Rojo: la columna `auth.sesion.factor`, las rutas `/auth/totp/*` y el guard de exigencia aún no existen (T5, T7).
import { estadoFactorSchema } from "@contapp/shared";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { claveCorreo, cookieSesion, COOKIE } from "../../../test/soporte.js";
import type { Actor, Banco, RolSistema } from "../../../test/soporte-acceso.js";
import {
  abrirPlanesTotp,
  activarTotp,
  codigoErroneo,
  congelarReloj,
  contadorFallos,
  elegirEstudio,
  entrarConTotp,
  entrarSinTotp,
  eventos,
  EXIGIDO,
  filaTotp,
  FORMATO_CODIGO_RECUPERACION,
  loginPendiente,
  sesionesDe,
  verificar,
  type CuentaTotp,
  type Reloj,
} from "../../../test/soporte-totp.js";
import type { BancoPlanes, SuperAdmin } from "../../../test/soporte-planes.js";

let p: BancoPlanes;
let b: Banco;
let reloj: Reloj;
beforeAll(async () => {
  p = await abrirPlanesTotp();
  b = p.b;
});
afterAll(async () => {
  await p?.cerrar();
});
afterEach(() => reloj?.liberar());

const h = () => b.h;
const llamar = (a: { cookie: string; csrf: string; tenantId: string }, metodo: "GET" | "POST", ruta: string, cuerpo?: unknown) =>
  b.llamar(a, metodo, ruta, cuerpo);
const conTotp = (a: Actor): Promise<CuentaTotp & { tenantId: string }> =>
  activarTotp(h(), a, reloj).then((c) => ({ ...c, tenantId: a.tenantId }));
/** Un rol en un estudio nuevo, sin TOTP y con sesión viva (`sin_factor`). */
async function miembroDe(rol: RolSistema): Promise<Actor> {
  reloj = congelarReloj();
  const e = await b.estudio();
  return b.miembro(e.tenantId, rol);
}

describe("CA-4 · U1: Dueño y Administrador sin factor reciben 403 segundo_factor_requerido en el estudio", () => {
  it.each<RolSistema>(["dueno", "admin"])("%s sin TOTP: 403 en una ruta de estudio y en una con permiso, y el cuerpo es solo { codigo }", async (rol) => {
    const a = await miembroDe(rol);
    for (const ruta of ["/estudio/actual", "/clientes"]) {
      const r = await llamar(a, "GET", ruta);
      expect(r.status, ruta).toBe(403);
      expect(r.body).toEqual(EXIGIDO);
      expect(r.headers["cache-control"]).toMatch(/no-store/);
    }
  });

  it.each<RolSistema>(["contador", "asistente", "lectura"])("%s (U1: opcional) sigue entrando sin TOTP", async (rol) => {
    const a = await miembroDe(rol);
    const r = await llamar(a, "GET", "/estudio/actual");
    expect(r.status).toBe(200);
    const s = await h().pedir({ ruta: "/auth/sesion", cookie: a.cookie });
    expect(s.body).toMatchObject({ factor: "sin_factor", totpActivo: false, factorExigido: false });
  });

  it("con el TOTP verificado la misma ruta pasa; con una sesión sin_factor de una cuenta con TOTP (previa al despliegue) vuelve el 403", async () => {
    const a = await miembroDe("dueno");
    const c = await conTotp(a);
    expect((await llamar(c, "GET", "/estudio/actual")).status).toBe(200);
    expect((await llamar(c, "GET", "/clientes")).status).toBe(200);
    await h().sql("update auth.sesion set factor = 'sin_factor' where usuario_id = $1 and revocada_en is null", [a.id]);
    const r = await llamar(c, "GET", "/estudio/actual");
    expect(r.status).toBe(403);
    expect(r.body).toEqual(EXIGIDO);
  });

  it("una sesión pendiente nunca llega al estudio: 401, no 403", async () => {
    const a = await miembroDe("admin");
    const c = await conTotp(a);
    const pend = await loginPendiente(h(), a);
    const r = await h().pedir({ ruta: "/estudio/actual", cookie: pend.cookie, csrf: pend.csrf, estudio: c.tenantId });
    expect(r.status).toBe(401);
  });
});

describe("CA-4 · la lista cerrada sin factor exigido", () => {
  it("GET /auth/sesion informa factor, totpActivo y factorExigido; enrolar, confirmar, estudios y logout siguen abiertos", async () => {
    const a = await miembroDe("dueno");
    const s = await h().pedir({ ruta: "/auth/sesion", cookie: a.cookie });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ factor: "sin_factor", totpActivo: false, factorExigido: true });
    expect(estadoFactorSchema.safeParse({ factor: s.body.factor, totpActivo: s.body.totpActivo, factorExigido: s.body.factorExigido }).success).toBe(true);

    expect((await h().pedir({ ruta: "/auth/estudios", cookie: a.cookie })).status).toBe(200);
    const el = await h().pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: a.tenantId }, cookie: a.cookie, csrf: a.csrf });
    expect(el.status).toBe(200);
    const nueva = { cookie: `${COOKIE}=${cookieSesion(el)!.valor}`, csrf: "" };
    nueva.csrf = (await h().pedir({ ruta: "/auth/sesion", cookie: nueva.cookie })).body.csrf;
    const enr = await h().pedir({ ruta: "/auth/totp/enrolar", cuerpo: { contrasena: a.contrasena }, cookie: nueva.cookie, csrf: nueva.csrf });
    expect(enr.status).toBe(200);
    const out = await h().pedir({ ruta: "/auth/logout", cuerpo: {}, cookie: nueva.cookie, csrf: nueva.csrf });
    expect(out.status).toBe(204);
  });

  it("fuera de la lista (cualquier ruta de estudio o de plataforma) el 403 llega antes que la validación del cuerpo", async () => {
    const a = await miembroDe("dueno");
    const rutas: Array<["GET" | "POST", string, unknown]> = [
      ["GET", "/estudio/actual", undefined],
      ["GET", "/clientes", undefined],
      ["GET", "/auditoria", undefined],
      ["POST", "/clientes", { cuerpo: "inválido" }],
    ];
    for (const [m, ruta, cuerpo] of rutas) {
      const r = await llamar(a, m, ruta, cuerpo);
      expect(r.status, `${m} ${ruta}`).toBe(403);
      expect(r.body, `${m} ${ruta}`).toEqual(EXIGIDO);
    }
  });

  it("al confirmar el enrolamiento la sesión rotada es verificada y lo bloqueado se abre sin volver a entrar", async () => {
    const a = await miembroDe("dueno");
    expect((await llamar(a, "GET", "/estudio/actual")).status).toBe(403);
    const c = await conTotp(a);
    expect((await llamar(c, "GET", "/estudio/actual")).status).toBe(200);
    const s = await h().pedir({ ruta: "/auth/sesion", cookie: c.cookie });
    expect(s.body).toMatchObject({ factor: "verificado", totpActivo: true, factorExigido: true });
  });
});

describe("CA-4 · cambiar de estudio o de rol no esquiva la exigencia", () => {
  it("contador en A (no exigido) y Dueño en B (exigido): en A pasa; tras elegir B, 403; vuelve a pasar al regresar a A", async () => {
    reloj = congelarReloj();
    const A = await b.estudio();
    const B = await b.estudio();
    const m = await b.miembro(A.tenantId, "contador");
    await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'dueno')", [B.tenantId, m.id]);
    const s0 = await entrarSinTotp(h(), m); // dos estudios: sin estudio activo
    const enA = await elegirEstudio(h(), s0, A.tenantId);
    expect((await llamar({ ...enA, tenantId: A.tenantId }, "GET", "/estudio/actual")).status).toBe(200);
    const enB = await elegirEstudio(h(), enA, B.tenantId); // elegir estudio está en la lista cerrada
    const r = await llamar({ ...enB, tenantId: B.tenantId }, "GET", "/estudio/actual");
    expect(r.status).toBe(403);
    expect(r.body).toEqual(EXIGIDO);
    const deVuelta = await elegirEstudio(h(), enB, A.tenantId);
    expect((await llamar({ ...deVuelta, tenantId: A.tenantId }, "GET", "/estudio/actual")).status).toBe(200);
  });

  it("subir de rol con la sesión viva (contador → admin) exige el factor en la siguiente petición; bajarlo la libera", async () => {
    const a = await miembroDe("contador");
    expect((await llamar(a, "GET", "/estudio/actual")).status).toBe(200);
    await b.sql("update membresia set rol = 'admin' where tenant_id = $1 and usuario_id = $2", [a.tenantId, a.id]);
    const r = await llamar(a, "GET", "/estudio/actual");
    expect(r.status).toBe(403);
    expect(r.body).toEqual(EXIGIDO);
    await b.sql("update membresia set rol = 'contador' where tenant_id = $1 and usuario_id = $2", [a.tenantId, a.id]);
    expect((await llamar(a, "GET", "/estudio/actual")).status).toBe(200);
  });

  it("una membresía desactivada de Dueño no exige el factor", async () => {
    reloj = congelarReloj();
    const A = await b.estudio();
    const B = await b.estudio();
    const m = await b.miembro(A.tenantId, "contador");
    await b.sql("insert into membresia (tenant_id, usuario_id, rol, desactivada_en) values ($1, $2, 'dueno', now())", [B.tenantId, m.id]);
    const s = await h().pedir({ ruta: "/auth/sesion", cookie: m.cookie });
    expect(s.body.factorExigido).toBe(false);
    expect((await llamar(m, "GET", "/estudio/actual")).status).toBe(200);
  });
});

describe("CA-4 · plataforma: el super-admin no entra al panel solo con la contraseña", () => {
  let admin: SuperAdmin;
  const RUTAS: ReadonlyArray<readonly ["GET" | "POST" | "PUT", string, unknown]> = [
    ["GET", "/plataforma/yo", undefined],
    ["GET", "/plataforma/planes", undefined],
    ["POST", "/plataforma/planes", {}],
    ["PUT", `/plataforma/planes/${randomUUID()}`, {}],
    ["GET", "/plataforma/estudios", undefined],
    ["PUT", `/plataforma/estudios/${randomUUID()}/suscripcion`, {}],
  ];
  beforeAll(async () => {
    admin = await p.superAdmin();
  });

  it.each(RUTAS)("%s %s sin factor da 403 segundo_factor_requerido (antes de validar el cuerpo)", async (metodo, ruta, cuerpo) => {
    const r = await p.como(admin, metodo, ruta, cuerpo);
    expect(r.status).toBe(403);
    expect(r.body).toEqual(EXIGIDO);
  });

  it("con TOTP verificado entra; una sesión sin_factor de ese mismo super-admin vuelve a recibir 403; la pendiente 401", async () => {
    reloj = congelarReloj();
    const sa = await p.superAdmin();
    const s = await p.como(sa, "GET", "/auth/sesion");
    expect(s.body).toMatchObject({ factor: "sin_factor", totpActivo: false, factorExigido: true });
    const c = await activarTotp(h(), sa, reloj);
    const ok = await p.como(c, "GET", "/plataforma/yo");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ admin: true });
    const pend = await loginPendiente(h(), sa);
    expect((await p.como(pend, "GET", "/plataforma/yo")).status).toBe(401);
    await h().sql("update auth.sesion set factor = 'sin_factor' where id = (select id from auth.sesion where usuario_id = $1 and revocada_en is null and factor = 'verificado' limit 1)", [sa.id]);
    const r = await p.como(c, "GET", "/plataforma/planes");
    expect(r.status).toBe(403);
    expect(r.body).toEqual(EXIGIDO);
  });
});

describe("CA-4 · desactivar: solo sin exigencia en ningún estudio ni rol de plataforma", () => {
  const desactivar = (c: { cookie: string; csrf: string }, contrasena: unknown, codigo: unknown, extra: Record<string, unknown> = {}) =>
    h().pedir({ ruta: "/auth/totp/desactivar", cuerpo: { contrasena, codigo }, cookie: c.cookie, csrf: c.csrf, ...extra });

  it.each<RolSistema>(["dueno", "admin"])("%s con TOTP: 409 totp_exigido y el factor sigue activo", async (rol) => {
    const a = await miembroDe(rol);
    const c = await conTotp(a);
    reloj.avanzar(1);
    const r = await desactivar(c, a.contrasena, reloj.codigo(c.secreto));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "totp_exigido" });
    expect((await filaTotp(h(), a.id))?.activo_cifrado).toBeTruthy();
    expect((await eventos(h(), a.id)).map((e) => e.tipo)).not.toContain("totp_desactivado");
    expect((await llamar(c, "GET", "/estudio/actual")).status).toBe(200);
  });

  it("el super-admin tampoco lo desactiva", async () => {
    reloj = congelarReloj();
    const sa = await p.superAdmin();
    const c = await activarTotp(h(), sa, reloj);
    reloj.avanzar(1);
    const r = await desactivar(c, sa.contrasena, reloj.codigo(c.secreto));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "totp_exigido" });
    expect((await filaTotp(h(), sa.id))?.activo_cifrado).toBeTruthy();
  });

  it("un contador que es Dueño vigente en otro estudio no lo desactiva (la regla mira todas las membresías vigentes)", async () => {
    reloj = congelarReloj();
    const A = await b.estudio();
    const B = await b.estudio();
    const m = await b.miembro(A.tenantId, "contador");
    await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'dueno')", [B.tenantId, m.id]);
    const c = await activarTotp(h(), m, reloj);
    reloj.avanzar(1);
    const r = await desactivar(c, m.contrasena, reloj.codigo(c.secreto));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "totp_exigido" });
  });

  it("un contador sin exigencia lo desactiva (204): borra el factor, revoca las demás sesiones, avisa y deja evento", async () => {
    const a = await miembroDe("contador");
    const c = await conTotp(a);
    const otra = await entrarConTotp(h(), a, c.secreto, reloj); // sesión verificada distinta de la actual
    reloj.avanzar(1);
    const antes = h().correo.para(a.correo).length;
    const r = await desactivar(c, a.contrasena, reloj.codigo(c.secreto));
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect((await filaTotp(h(), a.id))?.activo_cifrado ?? null).toBeNull();
    expect((await h().sql("select count(*)::int as n from auth.totp_recuperacion where usuario_id = $1 and usado_en is null", [a.id]))[0].n).toBe(0);
    expect((await eventos(h(), a.id)).map((e) => e.tipo)).toContain("totp_desactivado");
    expect((await h().correo.esperar(a.correo, antes + 1)).length).toBeGreaterThan(antes);
    const login = await h().login(a.correo, a.contrasena);
    expect(login.body).not.toHaveProperty("segundoFactor"); // vuelve al login de un solo paso
    expect((await h().pedir({ ruta: "/auth/sesion", cookie: otra.cookie })).status).toBe(401);
  });

  it("contraseña errónea: 401 credenciales_invalidas; código erróneo: 401 codigo_invalido (suma al contador); el factor sigue activo", async () => {
    const a = await miembroDe("contador");
    const c = await conTotp(a);
    reloj.avanzar(1);
    const mala = await desactivar(c, "Contrasena-equivocada-1", reloj.codigo(c.secreto));
    expect(mala.status).toBe(401);
    expect(mala.body).toEqual({ codigo: "credenciales_invalidas" });
    const malo = await desactivar(c, a.contrasena, codigoErroneo(c.secreto, reloj.ahora()));
    expect(malo.status).toBe(401);
    expect(malo.body).toEqual({ codigo: "codigo_invalido" });
    expect((await contadorFallos(h(), claveCorreo(a.correo)))?.fallos).toBeGreaterThanOrEqual(1);
    expect((await filaTotp(h(), a.id))?.activo_cifrado).toBeTruthy();
  });

  it("cuerpo inválido 400; sin sesión 401; sin CSRF 403; Origin ajeno 403; con la sesión sin_factor no se desactiva", async () => {
    const a = await miembroDe("contador");
    const c = await conTotp(a);
    reloj.avanzar(1);
    const codigo = reloj.codigo(c.secreto);
    expect((await desactivar(c, a.contrasena, "12345")).status).toBe(400);
    expect((await desactivar(c, 123, codigo)).status).toBe(400);
    expect((await h().pedir({ ruta: "/auth/totp/desactivar", cuerpo: { contrasena: a.contrasena, codigo } })).status).toBe(401);
    expect((await h().pedir({ ruta: "/auth/totp/desactivar", cuerpo: { contrasena: a.contrasena, codigo }, cookie: c.cookie })).body).toEqual({ codigo: "csrf_invalido" });
    expect((await desactivar(c, a.contrasena, codigo, { origen: "https://evil.example" })).body).toEqual({ codigo: "origen_invalido" });
    await h().sql("update auth.sesion set factor = 'sin_factor' where usuario_id = $1 and revocada_en is null", [a.id]);
    const r = await desactivar(c, a.contrasena, codigo);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect((await filaTotp(h(), a.id))?.activo_cifrado).toBeTruthy();
  });
});

describe("CA-9 · regenerar los códigos de recuperación (U4)", () => {
  const regenerar = (c: { cookie: string; csrf: string }, contrasena: unknown, codigo: unknown, extra: Record<string, unknown> = {}) =>
    h().pedir({ ruta: "/auth/totp/recuperacion", cuerpo: { contrasena, codigo }, cookie: c.cookie, csrf: c.csrf, ...extra });

  it("con contraseña y código vigentes: 200 con 10 códigos nuevos (no-store); los anteriores dejan de valer y los nuevos sirven", async () => {
    const a = await miembroDe("contador");
    const c = await conTotp(a);
    reloj.avanzar(1);
    const r = await regenerar(c, a.contrasena, reloj.codigo(c.secreto));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(r.body)).toEqual(["codigosRecuperacion"]);
    const nuevos: string[] = r.body.codigosRecuperacion;
    expect(nuevos).toHaveLength(10);
    expect(new Set(nuevos).size).toBe(10);
    for (const n of nuevos) {
      expect(n).toMatch(FORMATO_CODIGO_RECUPERACION);
      expect(c.codigos).not.toContain(n);
    }
    expect((await eventos(h(), a.id)).map((e) => e.tipo)).toContain("recuperacion_regenerada");
    const viejo = await verificar(h(), await loginPendiente(h(), a), { codigoRecuperacion: c.codigos[0]! });
    expect(viejo.status).toBe(401);
    expect(viejo.body).toEqual({ codigo: "codigo_invalido" });
    const nuevo = await verificar(h(), await loginPendiente(h(), a), { codigoRecuperacion: nuevos[0]! });
    expect(nuevo.status).toBe(200);
  });

  it("contraseña errónea 401, código erróneo 401 y nada cambia; sin sesión 401; sin CSRF 403", async () => {
    const a = await miembroDe("contador");
    const c = await conTotp(a);
    reloj.avanzar(1);
    const codigo = reloj.codigo(c.secreto);
    expect((await regenerar(c, "Contrasena-equivocada-1", codigo)).body).toEqual({ codigo: "credenciales_invalidas" });
    expect((await regenerar(c, a.contrasena, codigoErroneo(c.secreto, reloj.ahora()))).body).toEqual({ codigo: "codigo_invalido" });
    expect((await h().pedir({ ruta: "/auth/totp/recuperacion", cuerpo: { contrasena: a.contrasena, codigo } })).status).toBe(401);
    expect((await h().pedir({ ruta: "/auth/totp/recuperacion", cuerpo: { contrasena: a.contrasena, codigo }, cookie: c.cookie })).status).toBe(403);
    expect((await eventos(h(), a.id)).map((e) => e.tipo)).not.toContain("recuperacion_regenerada");
    const sigue = await verificar(h(), await loginPendiente(h(), a), { codigoRecuperacion: c.codigos[0]! });
    expect(sigue.status).toBe(200); // los códigos originales seguían vigentes
  });
});

describe("CA-4 · el estado de la sesión es coherente con la BD", () => {
  it("las sesiones creadas antes de activar el TOTP quedan sin_factor; las nuevas del login con TOTP nacen pendiente y se verifican", async () => {
    const a = await miembroDe("contador");
    const antes = await sesionesDe(h(), a.id);
    expect(antes.every((f) => f.factor === "sin_factor")).toBe(true);
    const c = await conTotp(a);
    const pend = await loginPendiente(h(), a);
    const filas = await sesionesDe(h(), a.id);
    expect(filas.find((f) => f.revocada_en === null && f.factor === "pendiente")).toBeDefined();
    expect(filas.filter((f) => f.revocada_en === null && f.factor === "verificado")).toHaveLength(1);
    reloj.avanzar(1);
    await verificar(h(), pend, { codigo: reloj.codigo(c.secreto) });
    expect((await sesionesDe(h(), a.id)).filter((f) => f.revocada_en === null && f.factor === "pendiente")).toHaveLength(0);
  });
});
