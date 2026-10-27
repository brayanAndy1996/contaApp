/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T4 (005) · CA-2 (invitar), CA-3 (aceptar, D15) y CA-14 (sin fugas). `CupoUsuarios` (D11) va en cupo.int.spec.ts.
// Rojo: endpoints `/invitaciones` y funciones `auth.invitacion_*` aún no existen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirBanco,
  type Actor,
  type Banco,
  type Estudio,
} from "../../../test/soporte-acceso.js";
import { capturarLogs, esHashDe, forma, ORIGEN, sha256 } from "../../../test/soporte.js";

let b: Banco;
let E: Estudio;
let admin: Actor;
const PWD_NUEVA = "Clave-nueva-005-canario-ñ";

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  admin = await b.miembro(E.tenantId, "admin");
});
afterAll(async () => {
  await b?.cerrar();
});

const fila = async (correo: string) =>
  (await b.sql("select * from invitacion where tenant_id = $1 and correo = $2 order by creada_en desc", [E.tenantId, correo]))[0];
const consultar = (token: string) =>
  b.h.pedir({ ruta: "/invitaciones/consultar", cuerpo: { token } });
const aceptar = (token: string, nombre = "Nuevo Miembro", contrasena = PWD_NUEVA, extra: object = {}) =>
  b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre, contrasena, ...extra } });
const usuarioPorCorreo = async (correo: string) =>
  (await b.sql("select id from usuario where email = $1", [correo]))[0];

/** Invita y devuelve correo, token e id; registra el correo para limpiar al usuario que se cree. */
async function invitado(rol: Parameters<Banco["invitar"]>[2] = "contador") {
  const correo = b.correoNuevo();
  const { r, token } = await b.invitar(E.titular, correo, rol);
  expect(r.status).toBe(201);
  return { correo, token: token as string, id: r.body.id as string };
}

describe("CA-2 · invitar (RF-020, HU-03)", () => {
  it("crea la invitación: 201 sin token ni hash, solo SHA-256 en BD, 72 h y correo con el enlace #t=", async () => {
    const correo = b.correoNuevo();
    const { r, token } = await b.invitar(E.titular, correo, "asistente");
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ correo, rol: "asistente" });
    expect(typeof r.body.id).toBe("string");
    expect(JSON.stringify(r.body)).not.toMatch(/token|hash/i);
    expect(r.text).not.toContain(token as string);

    const f = await fila(correo);
    expect(Buffer.isBuffer(f.token_hash)).toBe(true);
    expect(f.token_hash).toHaveLength(32);
    expect(esHashDe(f.token_hash, token as string)).toBe(true);
    const texto = JSON.stringify(f);
    expect(texto).not.toContain(token as string);
    const horas = Number((await b.sql("select extract(epoch from (vence_en - creada_en)) / 3600 as h from invitacion where id = $1", [f.id]))[0].h);
    expect(horas).toBeCloseTo(72, 1);
    expect(f).toMatchObject({ tenant_id: E.tenantId, rol: "asistente", invitado_por: E.titular.id, aceptada_en: null, revocada_en: null });

    const mensajes = b.h.correo.para(correo);
    expect(mensajes).toHaveLength(1);
    expect(mensajes[0]!.texto).toContain(`${ORIGEN}/invitacion#t=${token}`);
  });

  it("responde y escribe lo mismo exista o no una cuenta con ese correo (sin enumeración)", async () => {
    const existente = await b.h.crearUsuario({ estudios: [] }); // cuenta en la plataforma, ajena al estudio
    const nuevo = b.correoNuevo();
    const a = await b.invitar(E.titular, existente.correo, "lectura");
    const c = await b.invitar(E.titular, nuevo, "lectura");
    expect(a.r.status).toBe(201);
    expect(c.r.status).toBe(201);
    const enmascarar = (v: unknown, correo: string, id: string) =>
      JSON.stringify(v).replaceAll(correo, "<correo>").replaceAll(id, "<id>").replace(/"\d{4}-\d\d-\d\dT[^"]+"/g, '"<fecha>"');
    expect(enmascarar(a.r.body, existente.correo, a.r.body.id)).toBe(enmascarar(c.r.body, nuevo, c.r.body.id));
    expect(Object.keys(a.r.body).sort()).toEqual(Object.keys(c.r.body).sort());
    const m1 = b.h.correo.para(existente.correo)[0]!;
    const m2 = b.h.correo.para(nuevo)[0]!;
    const sinToken = (m: typeof m1, correo: string, tok: string) =>
      JSON.stringify({ asunto: (m as any).asunto, texto: m.texto }).replaceAll(tok, "<t>").replaceAll(correo, "<c>");
    expect(sinToken(m1, existente.correo, a.token as string)).toBe(sinToken(m2, nuevo, c.token as string));
  });

  it("normaliza el correo (D13 de 004) antes de guardarlo", async () => {
    const base = b.correoNuevo();
    const r = await b.llamar(E.titular, "POST", "/invitaciones", { correo: `  ${base.toUpperCase()} `, rol: "lectura" });
    expect(r.status).toBe(201);
    expect(r.body.correo).toBe(base);
    expect(await fila(base)).toBeDefined();
  });

  it("el correo sale por la cola, fuera de la petición: con el envío retenido la respuesta no espera", async () => {
    const correo = b.correoNuevo();
    b.h.correo.retenido = true;
    try {
      const r = await b.llamar(E.titular, "POST", "/invitaciones", { correo, rol: "lectura" });
      expect(r.status).toBe(201);
      expect(b.h.correo.para(correo)).toHaveLength(0);
    } finally {
      b.h.correo.liberar();
    }
    expect(await b.h.correo.esperar(correo, 1)).toHaveLength(1);
  });

  it("409 a un miembro activo o desactivado del estudio y 409 si ya hay una invitación pendiente", async () => {
    const activo = await b.miembro(E.tenantId, "asistente", { sesion: false });
    const off = await b.miembro(E.tenantId, "lectura", { sesion: false });
    await b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, off.id]);
    for (const m of [activo, off]) {
      const r = await b.llamar(E.titular, "POST", "/invitaciones", { correo: m.correo, rol: "lectura" });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ codigo: "ya_es_miembro" });
      expect(await fila(m.correo)).toBeUndefined();
    }
    const { correo } = await invitado("lectura");
    const otra = await b.llamar(E.titular, "POST", "/invitaciones", { correo, rol: "contador" });
    expect(otra.status).toBe(409);
    expect(otra.body).toEqual({ codigo: "invitacion_existente" });
  });

  it("reenviar invalida el token anterior y manda uno nuevo; revocar lo anula; ambas dan 404 si ya no está viva", async () => {
    const { correo, token, id } = await invitado("contador");
    const antes = await fila(correo);
    const re = await b.llamar(E.titular, "POST", `/invitaciones/${id}/reenviar`);
    expect(re.status).toBe(200);
    expect(JSON.stringify(re.body)).not.toMatch(/token|hash/i);
    const nuevo = (await b.h.correo.esperar(correo, 2)).length === 2 ? b.h.correo.tokenDe(correo) : "";
    expect(nuevo).not.toBe("");
    expect(nuevo).not.toBe(token);
    const despues = await fila(correo);
    expect(despues.token_hash.equals(antes.token_hash)).toBe(false);
    expect(esHashDe(despues.token_hash, nuevo)).toBe(true);
    expect((await consultar(token)).status).toBe(400); // el anterior ya no vale
    expect((await consultar(nuevo)).status).toBe(200);

    expect((await b.llamar(E.titular, "POST", `/invitaciones/${id}/revocar`)).status).toBe(204);
    expect((await consultar(nuevo)).status).toBe(400);
    expect((await fila(correo)).revocada_en).not.toBeNull();
    expect((await b.llamar(E.titular, "POST", `/invitaciones/${id}/revocar`)).status).toBe(404);
    expect((await b.llamar(E.titular, "POST", `/invitaciones/${id}/reenviar`)).status).toBe(404);
  });

  it("reenviar o revocar una invitación de otro estudio, inexistente o mal formada da 404", async () => {
    const otro = await b.estudio();
    const ajena = await b.llamar(otro.titular, "POST", "/invitaciones", { correo: b.correoNuevo(), rol: "lectura" });
    expect(ajena.status).toBe(201);
    for (const id of [ajena.body.id, "00000000-0000-4000-8000-000000000000", "no-es-uuid"]) {
      for (const accion of ["reenviar", "revocar"]) {
        const r = await b.llamar(E.titular, "POST", `/invitaciones/${id}/${accion}`);
        expect(r.status).toBe(404);
      }
    }
    expect((await b.sql("select revocada_en from invitacion where id = $1", [ajena.body.id]))[0].revocada_en).toBeNull();
  });

  it("GET /invitaciones lista las pendientes con quién invitó, sin token ni hash", async () => {
    const { correo, token, id } = await invitado("lectura");
    const f = await fila(correo);
    const r = await b.llamar(admin, "GET", "/invitaciones");
    expect(r.status).toBe(200);
    const x = r.body.find((i: any) => i.id === id);
    expect(x).toMatchObject({ correo, rol: "lectura", vencida: false, invitadoPor: { usuarioId: E.titular.id } });
    expect(Object.keys(x).sort()).toEqual(["correo", "creadaEn", "id", "invitadoPor", "rol", "venceEn", "vencida"]);
    expect(Object.keys(x.invitadoPor).sort()).toEqual(["nombre", "usuarioId"]);
    expect(r.text).not.toContain(token);
    expect(r.text).not.toContain(f.token_hash.toString("hex"));
    expect(r.text).not.toContain(f.token_hash.toString("base64"));
    expect(r.text).not.toContain(f.token_hash.toString("base64url"));
    // Las de otro estudio no aparecen.
    const otro = await b.estudio();
    const ajena = await b.llamar(otro.titular, "POST", "/invitaciones", { correo: b.correoNuevo(), rol: "lectura" });
    expect(r.body.map((i: any) => i.id)).not.toContain(ajena.body.id);
  });

  it("una invitación vencida se marca como vencida en el listado y no se puede aceptar", async () => {
    const { correo, token, id } = await invitado("lectura");
    await b.sql("update invitacion set vence_en = now() - interval '1 minute' where id = $1", [id]);
    const lista = await b.llamar(E.titular, "GET", "/invitaciones");
    expect(lista.body.find((i: any) => i.id === id)).toMatchObject({ correo, vencida: true });
    expect((await consultar(token)).status).toBe(400);
  });
});

describe("CA-3 · aceptar (HU-03)", () => {
  it("consultar no tiene efectos: devuelve estudio, rol, correo y cuentaExiste", async () => {
    const { correo, token, id } = await invitado("contador");
    const r = await consultar(token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estudio: { nombre: expect.any(String) }, rol: "contador", correo, cuentaExiste: false });
    expect(Object.keys(r.body.estudio)).toEqual(["nombre"]); // sin id del estudio
    expect(await consultar(token)).toMatchObject({ status: 200 });
    const f = (await b.sql("select aceptada_en, revocada_en from invitacion where id = $1", [id]))[0];
    expect(f).toEqual({ aceptada_en: null, revocada_en: null });
    expect(await usuarioPorCorreo(correo)).toBeUndefined();
  });

  it("con cuenta nueva crea usuario, contraseña (política de 004) y membresía con el rol invitado, y deja iniciar sesión", async () => {
    const { correo, token, id } = await invitado("asistente");
    const antesCalculos = b.h.hasher.calculos;
    const r = await aceptar(token, "Ana Invitada");
    expect(r.status).toBe(204);
    expect(b.h.hasher.calculos).toBe(antesCalculos + 1); // fijarContrasena: un solo Argon2
    const u = await usuarioPorCorreo(correo);
    expect(u).toBeDefined();
    const m = (await b.sql("select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, u.id]))[0];
    expect(m).toEqual({ rol: "asistente", desactivada_en: null });
    const cred = (await b.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0];
    expect(cred.hash).toMatch(/^\$argon2id\$/);
    expect(cred.hash).not.toContain(PWD_NUEVA);
    expect(await b.h.hasher.verificar(cred.hash, PWD_NUEVA)).toBe(true);
    const inv = (await b.sql("select aceptada_en, aceptada_por from invitacion where id = $1", [id]))[0];
    expect(inv.aceptada_en).not.toBeNull();
    expect(inv.aceptada_por).toBe(u.id);
    expect((await b.h.login(correo, PWD_NUEVA)).status).toBe(200);
    expect(b.h.correo.para(correo).length).toBeGreaterThanOrEqual(1);
  });

  it("el rol, el tenantId y el usuarioId del cuerpo de aceptar se ignoran", async () => {
    const otro = await b.estudio();
    const { correo, token } = await invitado("lectura");
    const r = await aceptar(token, "Ignora", PWD_NUEVA, { rol: "dueno", tenantId: otro.tenantId, usuarioId: otro.titular.id, correo: "otro@x.test" });
    expect(r.status).toBe(204);
    const u = await usuarioPorCorreo(correo);
    const ms = await b.sql("select tenant_id, rol from membresia where usuario_id = $1", [u.id]);
    expect(ms).toEqual([{ tenant_id: E.tenantId, rol: "lectura" }]);
  });

  it("política de contraseña de 004: se rechaza antes de tocar el token y sin calcular Argon2", async () => {
    const { token, correo } = await invitado("lectura");
    const antes = b.h.hasher.calculos;
    for (const mala of ["corta", "x".repeat(129), ""]) {
      const r = await aceptar(token, "Mala", mala);
      expect(r.status).toBe(400);
      expect(r.body.codigo === "contrasena_invalida" || r.body.codigo === "solicitud_invalida").toBe(true);
    }
    expect((await aceptar(token, "Mala", "corta")).body.codigo).toBe("contrasena_invalida");
    expect(b.h.hasher.calculos).toBe(antes);
    expect((await consultar(token)).status).toBe(200); // el token sigue vivo
    expect(await usuarioPorCorreo(correo)).toBeUndefined();
  });

  it("dos aceptaciones a la vez del mismo token: una funciona y la otra falla; queda un solo usuario", async () => {
    const { correo, token } = await invitado("contador");
    const [r1, r2] = await Promise.all([aceptar(token, "Uno"), aceptar(token, "Dos")]);
    expect([r1.status, r2.status].sort()).toEqual([204, 400]);
    const perdedor = r1.status === 400 ? r1 : r2;
    expect(perdedor.body).toEqual({ codigo: "invitacion_invalida" });
    const filasU = await b.sql("select id from usuario where email = $1", [correo]);
    expect(filasU).toHaveLength(1);
    const ms = await b.sql("select 1 from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, filasU[0].id]);
    expect(ms).toHaveLength(1);
  });

  it("reusado, vencido, revocado, alterado o inexistente dan siempre la misma respuesta (consultar y aceptar)", async () => {
    const reusado = await invitado("lectura");
    expect((await aceptar(reusado.token)).status).toBe(204);
    const vencido = await invitado("lectura");
    await b.sql("update invitacion set vence_en = now() - interval '1 second' where id = $1", [vencido.id]);
    const revocado = await invitado("lectura");
    expect((await b.llamar(E.titular, "POST", `/invitaciones/${revocado.id}/revocar`)).status).toBe(204);
    const viva = await invitado("lectura");
    const alterado = viva.token.slice(0, -1) + (viva.token.endsWith("A") ? "B" : "A");
    const inexistente = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255)).toString("base64url");
    const otroEstudio = await b.estudio();
    const deOtro = await b.llamar(otroEstudio.titular, "POST", "/invitaciones", { correo: b.correoNuevo(), rol: "lectura" });
    expect(deOtro.status).toBe(201);
    const tokenOtro = await b.tokenDe(deOtro.body.correo);
    expect((await b.llamar(otroEstudio.titular, "POST", `/invitaciones/${deOtro.body.id}/revocar`)).status).toBe(204);

    const malos = [reusado.token, vencido.token, revocado.token, alterado, inexistente, tokenOtro];
    const consultas = [];
    const aceptaciones = [];
    for (const t of malos) {
      consultas.push(forma(await consultar(t)));
      aceptaciones.push(forma(await aceptar(t)));
    }
    for (const c of consultas) expect(c).toEqual(consultas[0]);
    for (const a of aceptaciones) expect(a).toEqual(aceptaciones[0]);
    expect(consultas[0]!.status).toBe(400);
    expect(consultas[0]!.body).toEqual({ codigo: "invitacion_invalida" });
    expect(aceptaciones[0]!.body).toEqual({ codigo: "invitacion_invalida" });
    // Ninguna de las inválidas creó cuentas.
    for (const x of [vencido, revocado]) expect(await usuarioPorCorreo(x.correo)).toBeUndefined();
    expect((await consultar(viva.token)).status).toBe(200); // la válida no se tocó
  });

  it("correo con cuenta existente (D15): aceptar da 409 requiere_sesion, no consume y no cambia su contraseña", async () => {
    const u = await b.h.crearUsuario({ estudios: [] });
    const { token, id } = await (async () => {
      const { r, token } = await b.invitar(E.titular, u.correo, "contador");
      expect(r.status).toBe(201);
      return { token: token as string, id: r.body.id as string };
    })();
    const c = await consultar(token);
    expect(c.body.cuentaExiste).toBe(true);
    const antes = (await b.sql("select hash, actualizada_en from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0];
    const r = await aceptar(token, "Intruso", "Otra-clave-005-ñ-canario");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "requiere_sesion" });
    const despues = (await b.sql("select hash, actualizada_en from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0];
    expect(despues).toEqual(antes);
    expect((await b.sql("select aceptada_en from invitacion where id = $1", [id]))[0].aceptada_en).toBeNull();
    expect((await b.sql("select 1 from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, u.id]))).toHaveLength(0);
    expect((await b.h.login(u.correo, u.contrasena)).status).toBe(200); // su contraseña de siempre sigue valiendo
    expect((await b.h.login(u.correo, "Otra-clave-005-ñ-canario")).status).toBe(401);
  });

  it("aceptar-con-sesion: el dueño de la cuenta acepta con su sesión y entra al estudio con el rol invitado", async () => {
    const u = await b.h.crearUsuario({ estudios: [] });
    const { r, token } = await b.invitar(E.titular, u.correo, "asistente");
    expect(r.status).toBe(201);
    const s = await b.h.entrar(u); // sesión sin estudio activo
    const acepta = await b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token }, cookie: s.cookie, csrf: s.csrf });
    expect(acepta.status).toBe(200);
    expect(acepta.body).toEqual({ estudio: { id: E.tenantId, nombre: expect.any(String) } });
    const m = (await b.sql("select rol from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, u.id]))[0];
    expect(m.rol).toBe("asistente");
    const inv = (await b.sql("select aceptada_por from invitacion where id = $1", [r.body.id]))[0];
    expect(inv.aceptada_por).toBe(u.id);
    const sesion = await b.sesion(u, E.tenantId);
    const yo = await b.llamar({ ...sesion, tenantId: E.tenantId }, "GET", "/acceso/yo");
    expect(yo.body.rol).toBe("asistente");
    // Reusar el token ya no sirve.
    const otra = await b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token }, cookie: s.cookie, csrf: s.csrf });
    expect(otra.status).toBe(400);
  });

  it("aceptar-con-sesion con otro correo, siendo ya miembro, sin sesión o sin CSRF: no consume el token", async () => {
    const u = await b.h.crearUsuario({ estudios: [] });
    const { r, token } = await b.invitar(E.titular, u.correo, "lectura");
    expect(r.status).toBe(201);
    // Otro usuario, con otro correo.
    const w = await b.h.crearUsuario({ estudios: [] });
    const sw = await b.h.entrar(w);
    const otroCorreo = await b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token }, cookie: sw.cookie, csrf: sw.csrf });
    expect(otroCorreo.status).toBe(400);
    expect(otroCorreo.body).toEqual({ codigo: "invitacion_invalida" });
    // Sin sesión y sin CSRF.
    expect((await b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token } })).status).toBe(401);
    const su = await b.h.entrar(u);
    const sinCsrf = await b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token }, cookie: su.cookie });
    expect(sinCsrf.status).toBe(403);
    expect((await b.sql("select aceptada_en from invitacion where id = $1", [r.body.id]))[0].aceptada_en).toBeNull();
    expect((await b.sql("select 1 from membresia where usuario_id in ($1, $2) and tenant_id = $3", [u.id, w.id, E.tenantId]))).toHaveLength(0);
    // Ya miembro (membresía creada por otra vía): misma respuesta que un token inválido.
    await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'lectura')", [E.tenantId, u.id]);
    const yaMiembro = await b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token }, cookie: su.cookie, csrf: su.csrf });
    expect(yaMiembro.status).toBe(400);
    expect(yaMiembro.body).toEqual({ codigo: "invitacion_invalida" });
  });

  it("aceptar con una sesión ya cerrada (revocada) da 401 y no consume", async () => {
    const u = await b.h.crearUsuario({ estudios: [] });
    const { r, token } = await b.invitar(E.titular, u.correo, "lectura");
    const s = await b.h.entrar(u);
    const salir = await b.h.pedir({ ruta: "/auth/logout", cuerpo: {}, cookie: s.cookie, csrf: s.csrf });
    expect(salir.status).toBeLessThan(300);
    const x = await b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token }, cookie: s.cookie, csrf: s.csrf });
    expect(x.status).toBe(401);
    expect((await b.sql("select aceptada_en from invitacion where id = $1", [r.body.id]))[0].aceptada_en).toBeNull();
  });

  it("la BD nunca guarda el token: ninguna columna de invitacion lo contiene tras todo el ciclo", async () => {
    const { correo, token } = await invitado("lectura");
    expect((await aceptar(token)).status).toBe(204);
    const f = await fila(correo);
    expect(JSON.stringify(f)).not.toContain(token);
    expect(f.token_hash.equals(sha256(Buffer.from(token, "base64url"))) || f.token_hash.equals(sha256(token))).toBe(true);
  });
});

describe("CA-14 · sin fugas (RNF-004)", () => {
  it("el token y la contraseña canario no aparecen en logs, errores ni respuestas", async () => {
    const { resultado, logs } = await capturarLogs(async () => {
      const correo = b.correoNuevo();
      const { r, token } = await b.invitar(E.titular, correo, "lectura");
      const respuestas = [r];
      respuestas.push(await consultar(token as string));
      respuestas.push(await aceptar(token as string, "Fuga", "corta")); // política
      respuestas.push(await aceptar(token as string, "Fuga", PWD_NUEVA)); // ok
      respuestas.push(await aceptar(token as string, "Fuga", PWD_NUEVA)); // reusado
      respuestas.push(await consultar("token-alterado-canario"));
      respuestas.push(await b.llamar(E.titular, "GET", "/invitaciones"));
      return { respuestas, token: token as string };
    });
    const { respuestas, token } = resultado;
    // Invitar, consultar, política, aceptar, reusado, alterado, listar: el flujo debe ocurrir de verdad.
    expect(respuestas.map((r) => r.status)).toEqual([201, 200, 400, 204, 400, 400, 200]);
    for (const r of respuestas) {
      expect(r.text).not.toContain(token);
      expect(r.text).not.toContain(PWD_NUEVA);
      expect(r.text).not.toContain("canario");
      expect(JSON.stringify(r.headers)).not.toContain(token);
    }
    for (const secreto of [token, PWD_NUEVA, "token-alterado-canario"]) expect(logs).not.toContain(secreto);
  });
});
