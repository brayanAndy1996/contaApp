// T7 (004) · CA-9 (multi-estudio, RF-013/HU-04) y CA-11 (el guard no anida withTenant; correo fuera de contexto).
// Rojo: `crearApp` aun no existe (T12).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  COOKIE,
  cookieSesion,
  forma,
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

const A = () => seedAuth().tenantA;
const B = () => seedAuth().tenantB;
const elegir = (s: { cookie: string; csrf: string }, tenantId: string) =>
  h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId }, cookie: s.cookie, csrf: s.csrf });

describe("CA-9 · lista de estudios (withUsuario)", () => {
  it("solo trae las membresías propias, con id, nombre y ultimoUsado", async () => {
    const soloA = await h.crearUsuario({ estudios: [A()] });
    const ambos = await h.crearUsuario({ estudios: [A(), B()] });
    const sA = await h.entrar(soloA);
    const sAB = await h.entrar(ambos);
    const la = await h.pedir({ ruta: "/auth/estudios", cookie: sA.cookie });
    expect(la.status).toBe(200);
    expect(la.body).toEqual([{ id: A(), nombre: nombreTenant(A()), ultimoUsado: expect.any(Boolean) }]);
    const lab = await h.pedir({ ruta: "/auth/estudios", cookie: sAB.cookie });
    expect(lab.body.map((e: { id: string }) => e.id).sort()).toEqual([A(), B()].sort());
    for (const e of lab.body) expect(Object.keys(e).sort()).toEqual(["id", "nombre", "ultimoUsado"]);
    expect((await h.pedir({ ruta: "/auth/estudios" })).status).toBe(401);
  });

  it("'último usado' marca el estudio de la sesión más reciente del usuario", async () => {
    const u = await h.crearUsuario({ estudios: [A(), B()] });
    const s = await h.entrar(u);
    const antes = await h.pedir({ ruta: "/auth/estudios", cookie: s.cookie });
    expect(antes.body.every((e: { ultimoUsado: boolean }) => e.ultimoUsado === false)).toBe(true);
    const r = await elegir(s, B());
    expect(r.status).toBe(200);
    // Un login nuevo (sin estudio todavía) ve como 'último usado' el de la sesión previa.
    const s2 = await h.entrar(u);
    const lista = await h.pedir({ ruta: "/auth/estudios", cookie: s2.cookie });
    const usado = lista.body.filter((e: { ultimoUsado: boolean }) => e.ultimoUsado).map((e: { id: string }) => e.id);
    expect(usado).toEqual([B()]);
  });
});

describe("CA-9 · elegir y cambiar de estudio", () => {
  it("al elegir uno, /estudio/actual devuelve solo ese estudio y se cambia sin contraseña (un estudio activo por sesión)", async () => {
    const u = await h.crearUsuario({ estudios: [A(), B()] });
    const s = await h.entrar(u);
    const sinElegir = await h.pedir({ ruta: "/estudio/actual", cookie: s.cookie, estudio: A() });
    expect(sinElegir.status).toBe(403);
    expect(sinElegir.body).toEqual({ codigo: "estudio_requerido" });

    const r = await elegir(s, A());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estudioActivo: { id: A(), nombre: nombreTenant(A()) } });
    const sA = { cookie: `${COOKIE}=${cookieSesion(r)!.valor}` };
    const act = await h.pedir({ ruta: "/estudio/actual", cookie: sA.cookie, estudio: A() });
    expect(act.status).toBe(200);
    expect(act.body).toEqual({ id: A(), nombre: nombreTenant(A()) });

    const sesA = await h.pedir({ ruta: "/auth/sesion", cookie: sA.cookie });
    const rB = await elegir({ cookie: sA.cookie, csrf: sesA.body.csrf }, B());
    expect(rB.status).toBe(200);
    const sB = `${COOKIE}=${cookieSesion(rB)!.valor}`;
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: sA.cookie })).status).toBe(401); // la anterior rota
    const actB = await h.pedir({ ruta: "/estudio/actual", cookie: sB, estudio: B() });
    expect(actB.body).toEqual({ id: B(), nombre: nombreTenant(B()) });
    const filas = await h.sesiones(u.id);
    expect(filas.filter((f) => f.revocada_en === null)).toHaveLength(1); // una sola sesión viva con un solo estudio
    expect(filas.find((f) => f.revocada_en === null)!.tenant_activo).toBe(B());
  });

  it("estudio ajeno e inexistente dan exactamente el mismo 403 y no tocan la sesión", async () => {
    const u = await h.crearUsuario({ estudios: [A()] });
    const s = await h.entrar(u);
    const ajeno = await elegir(s, B());
    const inexistente = await elegir(s, randomUUID());
    expect(ajeno.status).toBe(403);
    expect(ajeno.body).toEqual({ codigo: "estudio_no_disponible" });
    expect(forma(inexistente)).toEqual(forma(ajeno));
    expect(ajeno.setCookies).toEqual([]);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).status).toBe(200);
  });

  it("con la membresía revocada, la siguiente petición con ese estudio se rechaza y obliga a elegir de nuevo", async () => {
    const u = await h.crearUsuario({ estudios: [A(), B()] });
    const s0 = await h.entrar(u);
    const r = await elegir(s0, A());
    const cookie = `${COOKIE}=${cookieSesion(r)!.valor}`;
    expect((await h.pedir({ ruta: "/estudio/actual", cookie, estudio: A() })).status).toBe(200);

    await h.sql("delete from membresia where usuario_id = $1 and tenant_id = $2", [u.id, A()]);

    const rechazo = await h.pedir({ ruta: "/estudio/actual", cookie, estudio: A() });
    expect(rechazo.status).toBe(403);
    expect(rechazo.body).toEqual({ codigo: "estudio_requerido" });
    const ses = await h.pedir({ ruta: "/auth/sesion", cookie });
    expect(ses.status).toBe(200);
    expect(ses.body.estudioActivo).toBeNull(); // se limpió el estudio de la sesión
    expect((await h.pedir({ ruta: "/estudio/actual", cookie, estudio: A() })).status).toBe(403);
    // Elegir el estudio revocado falla igual que uno ajeno; el otro sigue disponible.
    const lista = await h.pedir({ ruta: "/auth/estudios", cookie });
    expect(lista.body.map((e: { id: string }) => e.id)).toEqual([B()]);
    expect((await elegir({ cookie, csrf: ses.body.csrf }, A())).body).toEqual({ codigo: "estudio_no_disponible" });
    expect((await elegir({ cookie, csrf: ses.body.csrf }, B())).status).toBe(200);
  });

  it("X-Estudio distinto o ausente da 409 estudio_desfasado; si coincide, 200", async () => {
    const u = await h.crearUsuario({ estudios: [A(), B()] });
    const s0 = await h.entrar(u);
    const r = await elegir(s0, A());
    const cookie = `${COOKIE}=${cookieSesion(r)!.valor}`;
    const distinto = await h.pedir({ ruta: "/estudio/actual", cookie, estudio: B() });
    expect(distinto.status).toBe(409);
    expect(distinto.body).toEqual({ codigo: "estudio_desfasado" });
    const ausente = await h.pedir({ ruta: "/estudio/actual", cookie });
    expect(ausente.status).toBe(409);
    expect(ausente.body).toEqual({ codigo: "estudio_desfasado" });
    expect((await h.pedir({ ruta: "/estudio/actual", cookie, estudio: A() })).status).toBe(200);
  });

  it("/estudio/actual sin sesión da 401", async () => {
    const r = await h.pedir({ ruta: "/estudio/actual", estudio: A() });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "sesion_invalida" });
  });

  it("un cuerpo sin tenantId o con un valor que no es UUID da 400 solicitud_invalida sin eco", async () => {
    const u = await h.crearUsuario({ estudios: [A()] });
    const s = await h.entrar(u);
    for (const cuerpo of [{}, { tenantId: "no-es-uuid-canario" }, { tenantId: 7 }]) {
      const r = await h.pedir({ ruta: "/auth/estudio", cuerpo, cookie: s.cookie, csrf: s.csrf });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      expect(r.text).not.toContain("canario");
    }
  });
});

describe("CA-11 · el correo se envía fuera de withUsuario/withTenant", () => {
  it("un Correo de prueba que llama a db.withUsuario y db.withTenant no recibe WithTenantAnidadoError", async () => {
    const u = await h.crearUsuario({ estudios: [A()] });
    const errores: unknown[] = [];
    let llamadas = 0;
    h.correo.alEnviar = async () => {
      llamadas += 1;
      try {
        await h.dbBackend.withUsuario({ userId: u.id }, (tx) => tx.query("select 1 as uno"));
        await h.dbBackend.withTenant({ tenantId: A() }, (tx) => tx.query("select 1 as uno"));
      } catch (e) {
        errores.push(e);
      }
    };
    try {
      expect((await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo } })).status).toBe(202);
      await h.correo.esperar(u.correo, 1);
      for (let i = 0; i < 5; i++) await h.login(u.correo, `incorrecta-${i}-Zz`); // aviso de bloqueo
      await h.correo.esperar(u.correo, 2);
    } finally {
      h.correo.alEnviar = null;
    }
    expect(llamadas).toBeGreaterThanOrEqual(2);
    expect(errores).toEqual([]);
  });

  it("el guard resuelve la sesión fuera de withTenant: /estudio/actual (que abre withTenant) funciona", async () => {
    const u = await h.crearUsuario({ estudios: [B()] });
    const s = await h.entrar(u);
    const r = await h.pedir({ ruta: "/estudio/actual", cookie: s.cookie, estudio: B() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: B(), nombre: nombreTenant(B()) });
  });
});
