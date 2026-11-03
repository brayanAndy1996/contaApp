/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// 006 T13a · Pruebas en rojo de las decisiones del usuario (D14, D15) y de los hallazgos de la ronda adversarial que los
// `registro-t12*.adv.int.spec.ts` no cubren (CA-12, CA-13, CA-14). Los implementa T13b (backend y migración 0025).
//
// Contrato HTTP que fija (plan.md, "Contratos: HTTP" y "Ajustes de la ronda adversarial"):
// - D14: `POST /registro/confirmar-con-sesion` → 200 `{ estudio: {id, nombre}, sinPlan: boolean }`. El 1.º estudio que una cuenta
//   origina tiene plan Prueba (`sinPlan: false`); los siguientes se crean con membresía de Dueño y SIN suscripción
//   (`sinPlan: true`). Con 5 simultáneos de la misma cuenta, exactamente 1 queda con Prueba. Una cuenta nueva por
//   `/registro/confirmar` ya cuenta como "prueba usada". Un estudio sin suscripción: `GET /plan/uso`, invitar y reservar RUCs
//   dan 409 `sin_plan`; su Dueño sigue entrando; `GET /plataforma/estudios` lo lista con `plan: null` y `estado: null`;
//   `PUT /plataforma/estudios/:id/suscripcion` le crea la suscripción `activa` (un no-admin recibe 403).
// - D15: `POST /registro/confirmar` → 429 `demasiados_intentos` al intento 11 en una hora desde la misma IP (tipo
//   `registro_confirmar_ip`). Cuenta todo intento que pasa la forma del cuerpo (también contraseña inválida); `consultar` y
//   `confirmar-con-sesion` no se limitan. N confirmaciones simultáneas del mismo enlace calculan el hash UNA vez y las
//   perdedoras dan 400 `registro_invalido`.
// - a2/b6: la IP del cliente se valida con `net.isIP` (tras quitar `::ffff:`); si no es una IP el sujeto del límite es la
//   constante `ip_invalida` (cubeta compartida) y nunca hay 500.
// - b4/a3/b5: largo del estudio por code points; U+2028/U+2029 rechazados; un CHECK de la BD que Node aceptó → 400
//   `solicitud_invalida`, igual exista o no la cuenta.
// Todo lo que crea (pendientes, cuentas, estudios, filas de límite de sus IP) lo limpia `abrirBancoPlanes().cerrar()` y `afterAll`.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claveCorreo, ipUnica, sha256, type Resp } from "../../../test/soporte.js";
import { abrirBancoPlanes, type BancoPlanes } from "../../../test/soporte-planes.js";
import { CupoRucsPlanes } from "../planes/cupo/cupo-rucs.js";
import { PlanNoDisponibleError } from "../planes/cupo/errores.js";

const CONTRASENA = "Canario-t13a-registro-Qx73-ñ";
let p: BancoPlanes;
const h = () => p.b.h;
const ips: string[] = [];
const correosLimite: string[] = [];

beforeAll(async () => {
  p = await abrirBancoPlanes();
  // El correo con NUL solo ejercita la limpieza del soporte (T13a, ajuste 4): no debe abortarla.
  p.rastrearRegistro("limpieza\u0000nul@t006.contapp.test");
  await limpiarInvalida();
});
afterAll(async () => {
  if (p) {
    await limpiarInvalida().catch(() => undefined);
    const sujetos = [...ips, ...ips.map((v) => `::ffff:${v}`), ...correosLimite.map((c) => claveCorreo(c).toString("hex"))];
    await p
      .sql(
        "delete from auth.limite_tasa where tipo in ('registro_ip', 'registro_correo', 'registro_confirmar_ip') and sujeto = any($1)",
        [sujetos],
      )
      .catch(() => undefined);
    await p.cerrar();
  }
});
/** Sujeto compartido de las IP que no son IP (b6): se vacía antes y después para contar desde cero. */
const limpiarInvalida = () =>
  p.sql("delete from auth.limite_tasa where tipo in ('registro_ip', 'registro_confirmar_ip') and sujeto = 'ip_invalida'");

/* ---------------------------------- utilidades ---------------------------------- */
const ip = (): string => {
  const v = ipUnica();
  ips.push(v);
  return v;
};
const tokenFalso = (): string => randomBytes(32).toString("base64url");
const no5xx = (r: Resp, que: string) => expect(r.status, `${que}: ${r.status} ${r.text.slice(0, 200)}`).toBeLessThan(500);

/** Pendiente insertado por SQL con un token conocido (el servicio guarda SHA-256 del token en UTF-8). */
async function pendiente(correo: string, estudio = `Estudio T13a ${randomBytes(3).toString("hex")}`) {
  const token = tokenFalso();
  await p.sql(
    `insert into auth.registro_pendiente (correo, nombre_estudio, ruc_estudio, nombre_usuario, token_hash)
     values ($1, $2, null, 'Titular T13a', $3)`,
    [correo.toLowerCase(), estudio, sha256(token)],
  );
  return { token, estudio };
}
async function cuentaExistente() {
  const u = await h().crearUsuario({ estudios: [] });
  p.rastrearRegistro(u.correo);
  correosLimite.push(u.correo);
  return u;
}
const confirmar = (token: string, o: { ip?: string | null; contrasena?: string } = {}) =>
  h().pedir({
    ruta: "/registro/confirmar",
    cuerpo: { token, contrasena: o.contrasena ?? CONTRASENA },
    ip: o.ip === undefined ? ip() : o.ip,
  });
const consultar = (token: string, ipx: string = ip()) => h().pedir({ ruta: "/registro/consultar", cuerpo: { token }, ip: ipx });
const conSesion = (s: { cookie: string; csrf: string }, token: string) =>
  p.como(s, "POST", "/registro/confirmar-con-sesion", { token });
const solicitar = (cuerpo: Record<string, unknown>, ipx: string | null = ip()) => {
  if (typeof cuerpo.correo === "string") correosLimite.push(cuerpo.correo);
  return h().pedir({ ruta: "/registro", cuerpo, ip: ipx });
};
const estudiosDe = (usuarioId: string) =>
  p.sql(
    `select m.tenant_id, m.rol, s.estado, pl.codigo
       from membresia m left join suscripcion s on s.tenant_id = m.tenant_id left join plan pl on pl.id = s.plan_id
      where m.usuario_id = $1 order by m.tenant_id`,
    [usuarioId],
  );
const origenDe = (usuarioId: string) => p.sql("select usuario_id, tenant_id from auth.prueba_origen where usuario_id = $1", [usuarioId]);
const limiteDe = (tipo: string, sujeto: string) =>
  p.sql("select tipo, sujeto, conteo from auth.limite_tasa where tipo = $1 and sujeto = $2", [tipo, sujeto]);
const usuarioPorCorreo = async (correo: string): Promise<string[]> =>
  (await p.sql<{ id: string }>("select id from usuario where lower(email) = lower($1)", [correo])).map((f) => f.id);

/** Cuenta con su 1.º estudio (Prueba) y un 2.º sin plan, y un actor con sesión activa en ese 2.º. */
async function estudioSinPlan() {
  const u = await cuentaExistente();
  const s = await h().entrar(u);
  const r1 = await conSesion(s, (await pendiente(u.correo)).token);
  const r2 = await conSesion(s, (await pendiente(u.correo)).token);
  expect(r1.status, JSON.stringify(r1.body)).toBe(200);
  expect(r2.status, JSON.stringify(r2.body)).toBe(200);
  expect(r2.body.sinPlan, "el 2.º estudio de la cuenta nace sin plan").toBe(true);
  const e2 = r2.body.estudio.id as string;
  const sesion = await p.b.sesion(u, e2);
  return { u, e1: r1.body.estudio.id as string, e2, actor: { ...sesion, tenantId: e2 } };
}

/* ================================ D14 · una prueba por cuenta ================================ */
describe("D14 / CA-12 · una cuenta origina como máximo una prueba en toda su vida", () => {
  it("confirmar-con-sesion repetido: el 1.º estudio con Prueba y sinPlan false; el 2.º y el 3.º sin suscripción y sinPlan true", async () => {
    const u = await cuentaExistente();
    const s = await h().entrar(u);
    const rs: Resp[] = [];
    for (let i = 0; i < 3; i++) rs.push(await conSesion(s, (await pendiente(u.correo)).token));
    for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(rs.map((r) => r.body.sinPlan)).toEqual([false, true, true]);
    const es = await estudiosDe(u.id);
    expect(es).toHaveLength(3);
    for (const e of es) expect(e.rol).toBe("dueno");
    const ids = rs.map((r) => r.body.estudio.id as string);
    expect(es.find((e) => e.tenant_id === ids[0])).toMatchObject({ codigo: "prueba", estado: "prueba" });
    expect(es.find((e) => e.tenant_id === ids[1])).toMatchObject({ codigo: null, estado: null });
    expect(es.find((e) => e.tenant_id === ids[2])).toMatchObject({ codigo: null, estado: null });
    expect(await origenDe(u.id)).toEqual([{ usuario_id: u.id, tenant_id: ids[0] }]);
  });

  it("5 confirmar-con-sesion simultáneos de la misma cuenta con enlaces distintos: exactamente 1 estudio con Prueba", async () => {
    for (let ronda = 0; ronda < 2; ronda++) {
      const u = await cuentaExistente();
      const s = await h().entrar(u);
      const tokens = [];
      for (let i = 0; i < 5; i++) tokens.push((await pendiente(u.correo)).token);
      const rs = await Promise.all(tokens.map((t) => conSesion(s, t)));
      for (const r of rs) expect(r.status, `ronda ${ronda}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(rs.filter((r) => r.body.sinPlan === false), `ronda ${ronda}`).toHaveLength(1);
      expect(rs.filter((r) => r.body.sinPlan === true), `ronda ${ronda}`).toHaveLength(4);
      const es = await estudiosDe(u.id);
      expect(es).toHaveLength(5);
      expect(es.filter((e) => e.codigo === "prueba")).toHaveLength(1);
      expect(es.filter((e) => e.codigo === null)).toHaveLength(4);
      const conPrueba = rs.find((r) => r.body.sinPlan === false)!.body.estudio.id;
      expect(es.find((e) => e.codigo === "prueba")!.tenant_id).toBe(conPrueba);
      expect(await origenDe(u.id)).toHaveLength(1);
    }
  });

  it("una cuenta nueva por /registro/confirmar queda registrada como 'prueba usada': su siguiente estudio nace sin plan", async () => {
    const correo = p.correoRegistro();
    correosLimite.push(correo);
    const { token, estudio } = await pendiente(correo);
    const r = await confirmar(token);
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const [uid] = await usuarioPorCorreo(correo);
    const primero = (await p.sql<{ id: string }>("select id from tenant where nombre = $1", [estudio]))[0]!;
    expect(await origenDe(uid!)).toEqual([{ usuario_id: uid, tenant_id: primero.id }]);
    const s = await h().entrar({ correo, contrasena: CONTRASENA });
    const r2 = await conSesion(s, (await pendiente(correo)).token);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.sinPlan).toBe(true);
    const es = await estudiosDe(uid!);
    expect(es).toHaveLength(2);
    expect(es.filter((e) => e.codigo === "prueba")).toHaveLength(1);
  });

  it("un estudio sin plan responde 409 sin_plan en GET /plan/uso, invitar y reservar RUCs, sin crear nada", async () => {
    const { e2, actor } = await estudioSinPlan();
    const uso = await p.b.llamar(actor, "GET", "/plan/uso");
    expect(uso.status).toBe(409);
    expect(uso.body).toEqual({ codigo: "sin_plan" });
    const correo = p.b.correoNuevo();
    const inv = await p.b.llamar(actor, "POST", "/invitaciones", { correo, rol: "lectura" });
    expect(inv.status).toBe(409);
    expect(inv.body).toEqual({ codigo: "sin_plan" });
    expect(await p.sql("select 1 from invitacion where tenant_id = $1", [e2])).toHaveLength(0);
    const cupo = new CupoRucsPlanes();
    await expect(h().dbBackend.withTenant({ tenantId: e2 }, (tx) => cupo.reservar(tx, e2, 1))).rejects.toBeInstanceOf(
      PlanNoDisponibleError,
    );
    await expect(h().dbBackend.withTenant({ tenantId: e2 }, (tx) => cupo.libres(tx, e2))).rejects.toBeInstanceOf(
      PlanNoDisponibleError,
    );
  });

  it("el Dueño del estudio sin plan sigue entrando: inicia sesión, elige ese estudio y lo ve como activo", async () => {
    const { u, e2 } = await estudioSinPlan();
    const s = await h().entrar(u); // dos estudios: pide elegir
    expect(s.login.status).toBe(200);
    const r = await p.como(s, "POST", "/auth/estudio", { tenantId: e2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.estudioActivo.id).toBe(e2);
  });

  it("GET /plataforma/estudios lo lista con plan nulo y estado nulo; sin 500, y los demás estudios siguen con su plan", async () => {
    const { e1, e2 } = await estudioSinPlan();
    const adm = await p.superAdmin();
    const r = await p.como(adm, "GET", "/plataforma/estudios");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const sin = r.body.find((x: any) => x.id === e2);
    expect(sin).toEqual({ id: e2, nombre: expect.any(String), plan: null, estado: null });
    expect(r.body.find((x: any) => x.id === e1)).toMatchObject({ plan: { codigo: "prueba" }, estado: "prueba" });
    for (const x of r.body) expect(Object.keys(x).sort()).toEqual(["estado", "id", "nombre", "plan"]);
  });

  it("PUT /plataforma/estudios/:id/suscripcion le crea la suscripción `activa` y desde ahí opera; un no-admin recibe 403 y no crea nada", async () => {
    const { u, e2, actor } = await estudioSinPlan();
    const plan = await p.plan({ maxUsuarios: 3, maxRucs: 10, maxRucsExtra: 2 });
    // un Dueño (incluso del propio estudio) no puede asignarse plan
    const propio = await p.b.llamar(actor, "PUT", `/plataforma/estudios/${e2}/suscripcion`, { planId: plan.id, rucsExtraContratados: 0 });
    expect(propio.status).toBe(403);
    const otro = await p.como(await h().entrar(u), "PUT", `/plataforma/estudios/${e2}/suscripcion`, {
      planId: plan.id,
      rucsExtraContratados: 0,
    });
    expect(otro.status).toBe(403);
    expect(await p.sql("select 1 from suscripcion where tenant_id = $1", [e2])).toHaveLength(0);
    // el super-admin sí
    const adm = await p.superAdmin();
    const r = await p.como(adm, "PUT", `/plataforma/estudios/${e2}/suscripcion`, { planId: plan.id, rucsExtraContratados: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ estudioId: e2, plan: { codigo: plan.codigo }, estado: "activa", rucsExtraContratados: 1 });
    expect(await p.sql("select estado, prueba_vence_en, rucs_extra_contratados from suscripcion where tenant_id = $1", [e2])).toEqual([
      { estado: "activa", prueba_vence_en: null, rucs_extra_contratados: 1 },
    ]);
    // y el estudio opera
    const uso = await p.b.llamar(actor, "GET", "/plan/uso");
    expect(uso.status, JSON.stringify(uso.body)).toBe(200);
    expect(uso.body.plan.codigo).toBe(plan.codigo);
    expect((await p.b.llamar(actor, "POST", "/invitaciones", { correo: p.b.correoNuevo(), rol: "lectura" })).status).toBe(201);
  });
});

/* ================================ D15 · límite al confirmar ================================ */
describe("D15 / CA-13 · POST /registro/confirmar: 10 intentos por hora por IP", () => {
  it("el intento 11 desde la misma IP da 429 demasiados_intentos; los 10 anteriores dieron 400 o 204", async () => {
    const mismaIp = ip();
    const estados: number[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await confirmar(tokenFalso(), { ip: mismaIp });
      expect(r.body, `intento ${i + 1}`).toEqual({ codigo: "registro_invalido" });
      estados.push(r.status);
    }
    const real = await pendiente(p.correoRegistro());
    estados.push((await confirmar(real.token, { ip: mismaIp })).status);
    expect(estados.slice(0, 9).every((s) => s === 400)).toBe(true);
    expect(estados[9]).toBe(204);
    const once = await confirmar(tokenFalso(), { ip: mismaIp });
    expect(once.status).toBe(429);
    expect(once.body).toEqual({ codigo: "demasiados_intentos" });
    const fila = await limiteDe("registro_confirmar_ip", mismaIp);
    expect(fila).toHaveLength(1);
  });

  it("agotada una IP, un enlace real desde OTRA IP se confirma (204); el 429 no consume ni hashea el enlace de la IP agotada", async () => {
    const agotada = ip();
    for (let i = 0; i < 10; i++) await confirmar(tokenFalso(), { ip: agotada });
    const correo = p.correoRegistro();
    const { token } = await pendiente(correo);
    const calculos = h().hasher.calculos;
    const bloqueada = await confirmar(token, { ip: agotada });
    expect(bloqueada.status).toBe(429);
    expect(h().hasher.calculos).toBe(calculos);
    expect((await consultar(token)).status, "el enlace sigue vivo").toBe(200);
    expect(await usuarioPorCorreo(correo)).toHaveLength(0);
    const libre = await confirmar(token, { ip: ip() });
    expect(libre.status, JSON.stringify(libre.body)).toBe(204);
    expect(await usuarioPorCorreo(correo)).toHaveLength(1);
  });

  it("cuentan también los intentos con contraseña inválida (pasan la forma del cuerpo): 10 de esos y el 11.º ya es 429", async () => {
    const mismaIp = ip();
    const { token } = await pendiente(p.correoRegistro());
    for (let i = 0; i < 10; i++) {
      const r = await confirmar(token, { ip: mismaIp, contrasena: "corta" });
      expect(r.status, `intento ${i + 1}`).toBe(400);
      expect(r.body.codigo).toBe("contrasena_invalida");
    }
    const once = await confirmar(token, { ip: mismaIp, contrasena: "corta" });
    expect(once.status).toBe(429);
    expect(once.body).toEqual({ codigo: "demasiados_intentos" });
  });

  it("un cuerpo mal formado (sin token) se rechaza antes del límite: 15 seguidos dan 400 solicitud_invalida y no gastan intentos", async () => {
    const mismaIp = ip();
    for (let i = 0; i < 15; i++) {
      const r = await h().pedir({ ruta: "/registro/confirmar", cuerpo: { contrasena: CONTRASENA }, ip: mismaIp });
      expect(r.status, `intento ${i + 1}`).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    const r = await confirmar(tokenFalso(), { ip: mismaIp });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "registro_invalido" });
  });

  it("la IPv4 y su forma IPv6 mapeada (::ffff:a.b.c.d) comparten el mismo contador", async () => {
    const v4 = ip();
    for (let i = 0; i < 10; i++) {
      const r = await confirmar(tokenFalso(), { ip: i % 2 === 0 ? v4 : `::ffff:${v4}` });
      expect(r.status, `intento ${i + 1}`).toBe(400);
    }
    expect((await confirmar(tokenFalso(), { ip: `::ffff:${v4}` })).status).toBe(429);
    expect((await confirmar(tokenFalso(), { ip: v4 })).status).toBe(429);
  });

  it("consultar y confirmar-con-sesion no se limitan por este contador (12 seguidos desde la misma IP)", async () => {
    const mismaIp = ip();
    const { token } = await pendiente(p.correoRegistro());
    for (let i = 0; i < 12; i++) {
      const r = await consultar(token, mismaIp);
      expect(r.status, `consultar ${i + 1}`).toBe(200);
    }
    const u = await cuentaExistente();
    const s = await h().entrar(u);
    for (let i = 0; i < 12; i++) {
      const r = await h().pedir({
        ruta: "/registro/confirmar-con-sesion",
        cuerpo: { token: tokenFalso() },
        cookie: s.cookie,
        csrf: s.csrf,
        ip: mismaIp,
      });
      expect(r.status, `con-sesion ${i + 1}`).toBe(400);
      expect(r.body).toEqual({ codigo: "registro_invalido" });
    }
    expect(await limiteDe("registro_confirmar_ip", mismaIp)).toHaveLength(0);
  });

  it("8 confirmaciones simultáneas del mismo enlace desde la misma IP calculan el hash UNA vez; las perdedoras dan 400 registro_invalido", async () => {
    const mismaIp = ip();
    const correo = p.correoRegistro();
    const { token } = await pendiente(correo);
    const antes = h().hasher.calculos;
    const rs = await Promise.all(Array.from({ length: 8 }, () => confirmar(token, { ip: mismaIp })));
    expect(rs.filter((r) => r.status === 204)).toHaveLength(1);
    const perdedoras = rs.filter((r) => r.status !== 204);
    expect(perdedoras).toHaveLength(7);
    for (const r of perdedoras) {
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ codigo: "registro_invalido" });
    }
    expect(h().hasher.calculos - antes).toBe(1);
    expect(await usuarioPorCorreo(correo)).toHaveLength(1);
  });
});

/* ================================ a2 / b6 · IP inválida ================================ */
describe("a2/b6 / CA-14 · una IP de cliente inválida o enorme usa el sujeto `ip_invalida` y nunca da 500", () => {
  const larga = `x${"a".repeat(220)}`;

  it("POST /registro con IP enorme o basura: nunca 500; el contador queda en la cubeta `ip_invalida`, no en la cadena cruda", async () => {
    for (const basura of [larga, "no-es-una-ip", "999.999.1.1", "<script>"]) {
      const r = await solicitar(
        { estudio: "Estudio IP inválida", nombre: "Titular T13a", correo: p.correoRegistro() },
        basura,
      );
      no5xx(r, `IP ${basura.slice(0, 12)}`);
      expect([202, 429]).toContain(r.status);
      expect(await limiteDe("registro_ip", basura), `fila cruda ${basura.slice(0, 12)}`).toHaveLength(0);
    }
    const f = await limiteDe("registro_ip", "ip_invalida");
    expect(f).toHaveLength(1);
    expect(Number(f[0].conteo)).toBeGreaterThanOrEqual(1);
  });

  it("POST /registro/confirmar con IP basura: la cubeta es compartida (10 entre cadenas distintas y el 11.º da 429) y falla cerrado", async () => {
    const basuras = [larga, "no-es-una-ip", "999.999.1.1", "<script>", "::ffff:", "1.2.3", "a:b:c", "fe80::zz", "0x7f.1"];
    for (const [i, b] of basuras.entries()) {
      const r = await confirmar(tokenFalso(), { ip: b });
      no5xx(r, `IP ${b.slice(0, 12)}`);
      expect(r.status, `intento ${i + 1}`).toBe(400);
      expect(r.body).toEqual({ codigo: "registro_invalido" });
    }
    expect(await limiteDe("registro_confirmar_ip", larga)).toHaveLength(0);
    const f = await limiteDe("registro_confirmar_ip", "ip_invalida");
    expect(f).toHaveLength(1);
    expect(Number(f[0].conteo)).toBe(basuras.length);
    await confirmar(tokenFalso(), { ip: "basura-t13a-10" }); // el 10.º intento de la cubeta
    const once = await confirmar(tokenFalso(), { ip: "otra-basura-t13a" });
    expect(once.status).toBe(429);
    expect(once.body).toEqual({ codigo: "demasiados_intentos" });
    await limpiarInvalida();
  });
});

/* ================================ b4 / a3 / b5 · nombres ================================ */
describe("b4/a3/b5 / CA-14 · nombres que Node y PostgreSQL clasifican distinto", () => {
  const pendientesDe = (correo: string) => p.sql("select * from auth.registro_pendiente where correo = $1", [correo]);

  it("b4 · el largo del estudio se mide en code points: 120 letras fuera del BMP (240 UTF-16) → 202; 201 code points → 400", async () => {
    const ok = p.correoRegistro();
    const r = await solicitar({ estudio: "\u{1D400}".repeat(120), nombre: "Titular T13a", correo: ok });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const f = await pendientesDe(ok);
    expect(f).toHaveLength(1);
    expect([...String(f[0].nombre_estudio)]).toHaveLength(120);
    const mal = p.correoRegistro();
    const r2 = await solicitar({ estudio: "\u{1D400}".repeat(201), nombre: "Titular T13a", correo: mal });
    expect(r2.status).toBe(400);
    expect(r2.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await pendientesDe(mal)).toHaveLength(0);
  });

  it.each([
    ["U+2028", " "],
    ["U+2029", " "],
  ])("a3 · %s en el nombre del estudio o del titular → 400 solicitud_invalida, sin pendiente ni 500", async (_n, c) => {
    for (const [campo, cuerpo] of [
      ["estudio", { estudio: `Estudio${c}Adv`, nombre: "Titular T13a" }],
      ["nombre", { estudio: "Estudio Adv T13a", nombre: `Titular${c}Adv` }],
    ] as const) {
      const correo = p.correoRegistro();
      const r = await solicitar({ ...cuerpo, correo });
      expect(r.status, `${campo}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      expect(await pendientesDe(correo)).toHaveLength(0);
    }
  });

  it("b5 · un nombre que PG rechaza y Node acepta (U+10D50) da 400 solicitud_invalida, igual exista o no la cuenta", async () => {
    const u = await cuentaExistente();
    const nuevo = p.correoRegistro();
    const malo = "\u{10D50}";
    const antes = h().correo.para(u.correo).length;
    const a = await solicitar({ estudio: "Estudio Adv T13a", nombre: malo, correo: nuevo });
    const b = await solicitar({ estudio: "Estudio Adv T13a", nombre: malo, correo: u.correo });
    expect(a.status, JSON.stringify(a.body)).toBe(400);
    expect(b.status, JSON.stringify(b.body)).toBe(400);
    expect(a.body).toEqual({ codigo: "solicitud_invalida" });
    expect(b.body).toEqual(a.body);
    expect(await pendientesDe(nuevo)).toHaveLength(0);
    expect(await pendientesDe(u.correo.toLowerCase())).toHaveLength(0);
    expect(h().correo.para(u.correo).length).toBe(antes);
    expect(h().correo.para(nuevo)).toHaveLength(0);
  });
});
