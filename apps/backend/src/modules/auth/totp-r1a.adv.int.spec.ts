/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// T12 (029) · Ronda adversarial 1a, caja negra (CA-11). Solo spec, plan (contratos HTTP) y los soportes de prueba; sin leer la
// implementación. Cada prueba que falla es un hallazgo. Ataques: replay entre rutas y tras confirmar, reloj que retrocede, carreras entre
// rutas, el login con contraseña como reinicio del contador, fuerza bruta en otros pasos, cuerpos que amplifican intentos, CSRF tras
// rotar, Origen parecido, rutas con mayúsculas o barra final, lista cerrada de la exigencia y revocar mientras la sesión rota.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { claveCorreo, cookieSesion, ORIGEN, seedAuth, type Harness, type Resp } from "../../../test/soporte.js";
import type { Banco } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTotp,
  activarTotp,
  codigoErroneo,
  congelarReloj,
  contadorFallos,
  entrarConTotp,
  entrarSinTotp,
  EXIGIDO,
  filaTotp,
  loginPendiente,
  sesionDeCookie,
  verificar,
  type CuentaTotp,
  type Reloj,
  type SesionTotp,
} from "../../../test/soporte-totp.js";

let b: Banco;
let h: Harness;
let reloj: Reloj | undefined;
beforeAll(async () => {
  b = await abrirBancoTotp();
  h = b.h;
});
afterAll(async () => {
  await b?.cerrar();
});
afterEach(() => {
  reloj?.liberar();
  reloj = undefined;
});

type U = { id: string; correo: string; contrasena: string };

/** Contador sin estudios (sin exigencia) con TOTP activo; el paso de activación ya quedó usado. */
async function conTotp(estudios: string[] = []): Promise<{ u: U; cuenta: CuentaTotp; r: Reloj }> {
  const r = congelarReloj();
  reloj = r;
  const u = await h.crearUsuario({ estudios });
  const cuenta = await activarTotp(h, u, r);
  return { u, cuenta, r };
}

const post = (s: { cookie: string; csrf: string }, ruta: string, cuerpo: unknown = {}, extra: Record<string, unknown> = {}): Promise<Resp> =>
  h.pedir({ ruta, cuerpo, cookie: s.cookie, csrf: s.csrf, ...extra });
const vive = async (cookie: string): Promise<boolean> => (await h.pedir({ ruta: "/auth/sesion", cookie })).status === 200;
/** Bloqueo vigente según el reloj de la BD (el `Date` del proceso está congelado). */
const bloqueada = async (u: U): Promise<boolean> =>
  (await h.sql("select coalesce(bloqueado_hasta > now(), false) as b from auth.intento_login where clave = $1", [claveCorreo(u.correo)]))[0]?.b === true;
const ok = (r: Resp) => r.status >= 200 && r.status < 300;

describe("R1a · replay y reloj (CA-2, D3)", () => {
  it("un código usado en el segundo paso no sirve después para regenerar ni para desactivar (replay entre rutas)", async () => {
    const { u, cuenta, r } = await conTotp();
    const v = await entrarConTotp(h, u, cuenta.secreto, r); // consume el paso actual
    const usado = r.codigo(cuenta.secreto);
    const reg = await post(v, "/auth/totp/recuperacion", { contrasena: u.contrasena, codigo: usado });
    expect(reg.status, JSON.stringify(reg.body)).toBe(401);
    const des = await post(v, "/auth/totp/desactivar", { contrasena: u.contrasena, codigo: usado });
    expect(des.status, JSON.stringify(des.body)).toBe(401);
    expect((await filaTotp(h, u.id))?.activo_cifrado).toBeTruthy();
  });

  it("el código con el que se confirmó el enrolamiento (y el del paso previo) no sirve en el primer login", async () => {
    const { u, cuenta, r } = await conTotp();
    const p = await loginPendiente(h, u);
    expect((await verificar(h, p, { codigo: r.codigo(cuenta.secreto) })).status).toBe(401);
    expect((await verificar(h, p, { codigo: r.codigo(cuenta.secreto, -1) })).status).toBe(401);
    r.avanzar(1);
    expect((await verificar(h, p, { codigo: r.codigo(cuenta.secreto) })).status).toBe(200);
  });

  it("tras aceptar un código del paso futuro (+1), ni el paso actual ni un reloj que retrocede reabren pasos ya superados", async () => {
    const { u, cuenta, r } = await conTotp();
    const p1 = await loginPendiente(h, u);
    expect((await verificar(h, p1, { codigo: r.codigo(cuenta.secreto, 1) })).status).toBe(200);
    const p2 = await loginPendiente(h, u);
    expect((await verificar(h, p2, { codigo: r.codigo(cuenta.secreto) })).status, "paso anterior al último aceptado").toBe(401);
    r.avanzar(-3); // corrección NTP hacia atrás
    expect((await verificar(h, p2, { codigo: r.codigo(cuenta.secreto) })).status).toBe(401);
    expect((await verificar(h, p2, { codigo: r.codigo(cuenta.secreto, 1) })).status).toBe(401);
    r.avanzar(5);
    const p3 = await loginPendiente(h, u);
    expect((await verificar(h, p3, { codigo: r.codigo(cuenta.secreto) })).status).toBe(200);
  });

  it("carrera entre rutas: el mismo código a la vez en verificar, regenerar y desactivar; como mucho una tiene éxito", async () => {
    const { u, cuenta, r } = await conTotp();
    const v = await entrarConTotp(h, u, cuenta.secreto, r);
    r.avanzar(1);
    const p = await loginPendiente(h, u);
    const codigo = r.codigo(cuenta.secreto);
    const rs = await Promise.all([
      verificar(h, p, { codigo }),
      post(v, "/auth/totp/recuperacion", { contrasena: u.contrasena, codigo }),
      post(v, "/auth/totp/desactivar", { contrasena: u.contrasena, codigo }),
      verificar(h, p, { codigo }),
    ]);
    expect(rs.every((x) => x.status < 500), JSON.stringify(rs.map((x) => x.status))).toBe(true);
    expect(rs.filter(ok).length, JSON.stringify(rs.map((x) => x.status))).toBeLessThanOrEqual(1);
  });
});

describe("R1a · fuerza bruta del segundo paso (CA-3)", () => {
  it("un login correcto con contraseña no reinicia el contador: 4 códigos malos, nuevo login y 1 malo más bloquean", async () => {
    const { u, cuenta, r } = await conTotp();
    const p1 = await loginPendiente(h, u);
    for (let i = 0; i < 4; i++) expect((await verificar(h, p1, { codigo: codigoErroneo(cuenta.secreto, r.ahora()) })).status).toBe(401);
    const p2 = await loginPendiente(h, u); // con 4 erróneos aún no hay bloqueo: la contraseña buena entra
    const quinto = await verificar(h, p2, { codigo: codigoErroneo(cuenta.secreto, r.ahora()) });
    expect(quinto.status).not.toBe(200);
    expect(await bloqueada(u), "5 códigos erróneos en total deben bloquear aunque entre medias haya un login correcto").toBe(true);
    r.avanzar(1);
    const l3 = await h.login(u.correo, u.contrasena);
    expect(cookieSesion(l3)?.valor ?? "", `login tras 5 erróneos: HTTP ${l3.status}`).toBe("");
  });

  it("el contador es uno para todos los pasos: 2 malos al regenerar + 2 al desactivar y el 5.º (bueno) al verificar se rechaza", async () => {
    const { u, cuenta, r } = await conTotp();
    const v = await entrarConTotp(h, u, cuenta.secreto, r);
    const p = await loginPendiente(h, u); // antes de los erróneos: no depende del login
    for (const ruta of ["/auth/totp/recuperacion", "/auth/totp/recuperacion", "/auth/totp/desactivar", "/auth/totp/desactivar"]) {
      const x = await post(v, ruta, { contrasena: u.contrasena, codigo: codigoErroneo(cuenta.secreto, r.ahora()) });
      expect(x.status, `${ruta}: ${JSON.stringify(x.body)}`).toBe(401);
    }
    r.avanzar(1);
    const quinto = await verificar(h, p, { codigo: r.codigo(cuenta.secreto) });
    expect(quinto.status, JSON.stringify(quinto.body)).not.toBe(200);
    expect(await bloqueada(u)).toBe(true);
  });

  it("20 regeneraciones concurrentes con código erróneo: como mucho 5 evaluaciones (codigo_invalido), el resto 429 y bloqueo", async () => {
    const { u, cuenta, r } = await conTotp();
    const v = await entrarConTotp(h, u, cuenta.secreto, r);
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => post(v, "/auth/totp/recuperacion", { contrasena: u.contrasena, codigo: codigoErroneo(cuenta.secreto, r.ahora()) })),
    );
    expect(rs.every((x) => x.status < 500 && !ok(x)), JSON.stringify(rs.map((x) => x.status))).toBe(true);
    expect(rs.filter((x) => x.body?.codigo === "codigo_invalido").length).toBeLessThanOrEqual(5);
    expect(await bloqueada(u)).toBe(true);
    r.avanzar(1);
    expect(ok(await post(v, "/auth/totp/recuperacion", { contrasena: u.contrasena, codigo: r.codigo(cuenta.secreto) }))).toBe(false);
  });

  it("20 confirmaciones concurrentes con código erróneo: como mucho 5 evaluaciones y después ni el bueno activa", async () => {
    const r = congelarReloj();
    reloj = r;
    const u = await h.crearUsuario();
    const s = await entrarSinTotp(h, u);
    const en = await post(s, "/auth/totp/enrolar", { contrasena: u.contrasena });
    expect(en.status).toBe(200);
    const secreto = new URL(en.body.uri).searchParams.get("secret")!;
    const rs = await Promise.all(Array.from({ length: 20 }, () => post(s, "/auth/totp/confirmar", { codigo: codigoErroneo(secreto, r.ahora()) })));
    expect(rs.every((x) => x.status < 500 && !ok(x))).toBe(true);
    expect(rs.filter((x) => x.body?.codigo === "codigo_invalido").length, JSON.stringify(rs.map((x) => x.status))).toBeLessThanOrEqual(5);
    const bueno = await post(s, "/auth/totp/confirmar", { codigo: r.codigo(secreto) });
    expect(ok(bueno), `confirmar tras 20 erróneos: HTTP ${bueno.status}`).toBe(false);
    expect((await filaTotp(h, u.id))?.activo_cifrado ?? null).toBeNull();
  });

  it("cuerpos que intentarían varios códigos en una petición (arreglo, número, objeto, ambos campos) dan 400 y no gastan intentos", async () => {
    const { u, cuenta, r } = await conTotp();
    const p = await loginPendiente(h, u);
    r.avanzar(1);
    const bueno = r.codigo(cuenta.secreto);
    const malos = Array.from({ length: 50 }, () => codigoErroneo(cuenta.secreto, r.ahora()));
    const antes = (await contadorFallos(h, claveCorreo(u.correo)))?.fallos ?? 0;
    for (const cuerpo of [
      { codigo: [...malos, bueno] },
      { codigo: Number(`1${bueno}`) },
      { codigo: { $ne: "" } },
      { codigo: `${bueno}\n` },
      { codigo: bueno, codigoRecuperacion: "AAAA-AAAA-AAAA" },
      { codigoRecuperacion: ["AAAA-AAAA-AAAA", "BBBB-BBBB-BBBB"] },
    ]) {
      const x = await verificar(h, p, cuerpo);
      expect(x.status, `${JSON.stringify(cuerpo).slice(0, 60)} → ${JSON.stringify(x.body)}`).toBe(400);
      expect(cookieSesion(x)).toBeUndefined();
    }
    expect((await contadorFallos(h, claveCorreo(u.correo)))?.fallos ?? 0).toBe(antes);
    expect((await verificar(h, p, { codigo: bueno })).status).toBe(200);
  });
});

describe("R1a · CSRF y Origen en el segundo paso", () => {
  it("el csrf de la pendiente no sirve con la cookie ya verificada (rotada), y el de la verificada no sirve en otra pendiente", async () => {
    const { u, cuenta, r } = await conTotp();
    const otra = await entrarConTotp(h, u, cuenta.secreto, r);
    const p = await loginPendiente(h, u);
    r.avanzar(1);
    const vr = await verificar(h, p, { codigo: r.codigo(cuenta.secreto) });
    const c = cookieSesion(vr)!;
    const nueva = await sesionDeCookie(h, c.valor);
    const x = await post({ cookie: nueva.cookie, csrf: p.csrf }, "/auth/sesiones/revocar-otras");
    expect(x.status).toBe(403);
    expect(await vive(otra.cookie)).toBe(true);
    const p2 = await loginPendiente(h, u);
    r.avanzar(1);
    const y = await verificar(h, { cookie: p2.cookie, csrf: nueva.csrf }, { codigo: r.codigo(cuenta.secreto) });
    expect(y.status).toBe(403);
    expect((await verificar(h, p2, { codigo: r.codigo(cuenta.secreto) })).status, "el código no debió consumirse").toBe(200);
  });

  it("Origin parecido, «null» o de otro puerto/esquema: 403 y el código no se consume", async () => {
    const { u, cuenta, r } = await conTotp();
    const p = await loginPendiente(h, u);
    r.avanzar(1);
    const codigo = r.codigo(cuenta.secreto);
    const base = new URL(ORIGEN);
    const otroPuerto = `${base.protocol}//${base.hostname}:${Number(base.port || 80) + 1}`;
    const otroEsquema = `${base.protocol === "https:" ? "http:" : "https:"}//${base.host}`;
    for (const origen of [`${ORIGEN}.evil.example`, "null", otroPuerto, otroEsquema, `${ORIGEN}@evil.example`]) {
      const x = await verificar(h, p, { codigo }, { origen });
      expect(x.status, `Origin ${origen}`).toBe(403);
    }
    const y = await verificar(h, p, { codigo }, { origen: null, secFetchSite: "cross-site" });
    expect(y.status, "sin Origin y Sec-Fetch-Site cross-site").toBe(403);
    expect((await verificar(h, p, { codigo })).status).toBe(200);
  });
});

describe("R1a · saltar la sesión pendiente o la exigencia", () => {
  it("variantes de ruta (mayúsculas, barra final, consulta) no abren nada a la pendiente ni al Dueño sin factor", async () => {
    const { u } = await conTotp([seedAuth().tenantA]);
    const p = await loginPendiente(h, u);
    for (const ruta of ["/AUTH/SESION", "/auth/sesion/", "/auth/Sesiones", "/auth/sesiones/", "/Clientes", "/clientes/?x=/auth/2fa/verificar"]) {
      const x = await h.pedir({ ruta, cookie: p.cookie, estudio: seedAuth().tenantA });
      expect([401, 404], `pendiente ${ruta}: ${x.status}`).toContain(x.status);
    }
    const { titular } = await b.estudio();
    for (const ruta of ["/Clientes", "/clientes/", "/clientes?r=/auth/sesion", "/CLIENTES"]) {
      const x = await b.llamar(titular, "GET", ruta);
      expect([403, 404], `Dueño sin factor ${ruta}: ${x.status}`).toContain(x.status);
      if (x.status === 403) expect(x.body).toEqual(EXIGIDO);
    }
  });

  it("un Dueño sin factor solo usa la lista cerrada: listar o revocar sesiones y cambiar la contraseña dan 403", async () => {
    const { titular } = await b.estudio();
    const otra = await b.sesion(titular, titular.tenantId);
    const casos: ReadonlyArray<readonly ["GET" | "POST", string, unknown]> = [
      ["GET", "/auth/sesiones", undefined],
      ["POST", "/auth/contrasena", { actual: titular.contrasena, nueva: `${titular.contrasena}-Nueva-9` }],
      ["POST", "/auth/sesiones/revocar-otras", {}],
      ["POST", "/auth/sesiones/cerrar-todas", {}], // la última: cierra también la actual
    ];
    const estados: string[] = [];
    for (const [metodo, ruta, cuerpo] of casos) {
      const x = await b.llamar(titular, metodo, ruta, cuerpo);
      estados.push(`${metodo} ${ruta} → ${x.status} ${JSON.stringify(x.body)}`);
    }
    expect(estados.filter((e) => !/→ 403 /.test(e)), estados.join("\n")).toEqual([]);
    expect(await vive(otra.cookie), "la otra sesión del Dueño no debió caer").toBe(true);
  });
});

describe("R1a · revocar mientras la sesión rota (CA-5)", () => {
  async function dosSesiones(): Promise<{ u: U; a: SesionTotp; vb: SesionTotp; cuenta: CuentaTotp; r: Reloj }> {
    const { u, cuenta, r } = await conTotp([seedAuth().tenantA, seedAuth().tenantB]);
    const vb = await entrarConTotp(h, u, cuenta.secreto, r);
    const a = await entrarConTotp(h, u, cuenta.secreto, r);
    return { u, a, vb, cuenta, r };
  }
  const rotar = (s: SesionTotp) => post(s, "/auth/estudio", { tenantId: seedAuth().tenantA });

  it("revocar-otras a la vez que la otra sesión cambia de estudio: no sobrevive ni la vieja ni la rotada", async () => {
    const vivas: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { a, vb } = await dosSesiones();
      const [rev, rot] = await Promise.all([post(a, "/auth/sesiones/revocar-otras"), rotar(vb)]);
      expect(rev.status).toBe(204);
      const c = cookieSesion(rot);
      if (await vive(vb.cookie)) vivas.push(`vuelta ${i}: la original`);
      if (rot.status === 200 && c && (await vive(`${vb.cookie.split("=")[0]}=${c.valor}`))) vivas.push(`vuelta ${i}: la rotada`);
      expect(await vive(a.cookie)).toBe(true);
    }
    expect(vivas).toEqual([]);
  });

  it("revocar por id a la vez que esa sesión cambia de estudio: su continuación rotada también muere", async () => {
    const vivas: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { a, vb } = await dosSesiones();
      const lista = await h.pedir({ ruta: "/auth/sesiones", cookie: vb.cookie });
      expect(lista.status).toBe(200);
      const idB = (lista.body as any[]).find((s) => s.actual)?.id as string;
      expect(idB).toBeTruthy();
      const [rev, rot] = await Promise.all([post(a, `/auth/sesiones/${idB}/revocar`), rotar(vb)]);
      expect(rev.status).toBe(204);
      const c = cookieSesion(rot);
      if (await vive(vb.cookie)) vivas.push(`vuelta ${i}: la original`);
      if (rot.status === 200 && c && (await vive(`${vb.cookie.split("=")[0]}=${c.valor}`))) vivas.push(`vuelta ${i}: la rotada (estado ${rot.status})`);
    }
    expect(vivas).toEqual([]);
  });
});
