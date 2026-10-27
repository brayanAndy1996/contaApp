// T7 (004) · CA-8 (recuperación RF-011), CA-6 (restablecer revoca todo), P9. Rojo: `crearApp` aun no existe (T12).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  claveCorreo,
  esHashDe,
  forma,
  ipUnica,
  pausa,
  type Harness,
  type UsuarioPrueba,
} from "../../../test/soporte.js";

let h: Harness;
beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  await h?.cerrar();
});

const NUEVA = "Contrasena-restablecida-004-kQ";
const solicitar = (correo: string, extra = {}) => h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo }, ...extra });
const restablecer = (token: string, contrasena = NUEVA) =>
  h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token, contrasena } });

async function conToken(): Promise<{ u: UsuarioPrueba; token: string }> {
  const u = await h.crearUsuario({ estudios: [] });
  const antes = h.correo.para(u.correo).length;
  expect((await solicitar(u.correo)).status).toBe(202);
  await h.correo.esperar(u.correo, antes + 1);
  return { u, token: h.correo.tokenDe(u.correo) };
}

describe("CA-8 · solicitar recuperación", () => {
  it("responde igual (202 {ok:true}, mismas cabeceras, sin Set-Cookie) exista o no el correo", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const existe = await solicitar(u.correo);
    const noExiste = await solicitar(h.correoInexistente());
    expect(existe.status).toBe(202);
    expect(existe.body).toEqual({ ok: true });
    expect(forma(noExiste)).toEqual(forma(existe));
    expect(existe.setCookies).toEqual([]);
    expect(existe.headers["cache-control"]).toMatch(/no-store/);
  });

  it("solo el correo existente recibe un mensaje, con el enlace /recuperar/nueva#t=<token> de 43 caracteres", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const ajeno = h.correoInexistente();
    await solicitar(u.correo);
    await solicitar(ajeno);
    const ms = await h.correo.esperar(u.correo, 1);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.texto).toMatch(/\/recuperar\/nueva#t=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/);
    expect(ms[0]!.texto).toContain(`${process.env.APP_ORIGIN ?? "http://localhost:3000"}/recuperar/nueva#t=`);
    await pausa(300);
    expect(h.correo.para(ajeno)).toHaveLength(0);
  });

  it("las variantes de mayúsculas y espacios del correo existente envían el mismo correo", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    expect((await solicitar(`  ${u.correo.toUpperCase()} `)).status).toBe(202);
    expect(await h.correo.esperar(u.correo, 1)).toHaveLength(1);
  });

  it("el envío (retenido o fallido) no altera la respuesta ni la espera", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    h.correo.retenido = true;
    try {
      const t0 = Date.now();
      const r = await solicitar(u.correo);
      expect(r.status).toBe(202);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(h.correo.para(u.correo)).toHaveLength(0);
    } finally {
      h.correo.liberar();
    }
    h.correo.fallar = new Error("SMTP caído");
    try {
      const f = await solicitar(u.correo);
      expect(f.status).toBe(202);
      expect(f.body).toEqual({ ok: true });
      await pausa(200);
    } finally {
      h.correo.fallar = null;
    }
  });

  it("el token se guarda como hash SHA-256 y vence a los 30 min", async () => {
    const { u, token } = await conToken();
    const filas = await h.sql("select * from auth.token_recuperacion where usuario_id = $1", [u.id]);
    expect(filas).toHaveLength(1);
    expect(esHashDe(filas[0].token_hash, token)).toBe(true);
    const enColumnas = await h.sql("select count(*)::int as n from auth.token_recuperacion t where t::text like '%' || $1 || '%'", [token]);
    expect(enColumnas[0].n).toBe(0);
    const [d] = await h.sql(
      "select extract(epoch from (expira_en - creado_en)) as seg from auth.token_recuperacion where usuario_id = $1",
      [u.id],
    );
    expect(Number(d.seg)).toBeGreaterThan(30 * 60 - 5);
    expect(Number(d.seg)).toBeLessThan(30 * 60 + 5);
  });

  it("pedir otro token invalida el anterior", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    await solicitar(u.correo);
    await h.correo.esperar(u.correo, 1);
    const t1 = h.correo.tokenDe(u.correo);
    await solicitar(u.correo);
    await h.correo.esperar(u.correo, 2);
    const t2 = h.correo.tokenDe(u.correo);
    expect(t2).not.toBe(t1);
    const r1 = await restablecer(t1);
    expect(r1.status).toBe(400);
    expect(r1.body).toEqual({ codigo: "token_invalido" });
    expect((await restablecer(t2)).status).toBe(204);
  });

  it("límites: 3 solicitudes por correo y hora (429 igual exista o no) y 10 por IP y hora", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    for (const correo of [u.correo, h.correoInexistente()]) {
      for (let i = 0; i < 3; i++) expect((await solicitar(correo)).status).toBe(202);
      const r = await solicitar(correo);
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ codigo: "demasiados_intentos" });
    }
    const ip = ipUnica();
    for (let i = 0; i < 10; i++) expect((await solicitar(h.correoInexistente(), { ip })).status).toBe(202);
    expect((await solicitar(h.correoInexistente(), { ip })).status).toBe(429);
  });
});

describe("CA-8 · restablecer", () => {
  it("el token es de un solo uso: funciona una vez (204, sin Set-Cookie) y la segunda da token_invalido", async () => {
    const { u, token } = await conToken();
    const r = await restablecer(token);
    expect(r.status).toBe(204);
    expect(r.setCookies).toEqual([]);
    const otra = await restablecer(token);
    expect(otra.status).toBe(400);
    expect(otra.body).toEqual({ codigo: "token_invalido" });
    expect((await h.login(u.correo, NUEVA)).status).toBe(200);
    expect((await h.login(u.correo, u.contrasena)).status).toBe(401);
  });

  it("vencido, alterado, truncado, mal formado, vacío y desconocido dan la misma respuesta que el reusado", async () => {
    const { u, token } = await conToken();
    await restablecer(token); // lo gasta
    const reusado = await restablecer(token);

    const venc = await conToken();
    await h.sql("update auth.token_recuperacion set expira_en = now() - interval '1 second' where usuario_id = $1", [venc.u.id]);
    const vencido = await restablecer(venc.token);

    const alterado = await restablecer(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`);
    const truncado = await restablecer(token.slice(0, 20));
    const malFormado = await restablecer("%%%no-es-base64url%%%");
    const vacio = await restablecer("");
    const desconocido = await restablecer("Z".repeat(43));
    const ajeno = await restablecer((await conToken()).token.split("").reverse().join(""));

    expect(reusado.status).toBe(400);
    expect(reusado.body).toEqual({ codigo: "token_invalido" });
    for (const r of [vencido, alterado, truncado, malFormado, desconocido, ajeno]) expect(forma(r)).toEqual(forma(reusado));
    expect(vacio.status).toBe(400); // cuerpo inválido o token inválido, pero sin 5xx
    expect(u.correo).toBeDefined();
  });

  it("dos consumos concurrentes del mismo token: uno funciona y el otro falla", async () => {
    const { token } = await conToken();
    const rs = await Promise.all([
      restablecer(token, "Contrasena-uno-004-aaaa"),
      restablecer(token, "Contrasena-dos-004-bbbb"),
      restablecer(token, "Contrasena-tres-004-cccc"),
      restablecer(token, "Contrasena-cuatro-004-dddd"),
    ]);
    expect(rs.filter((r) => r.status === 204)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(3);
  });

  it("la política se aplica antes de tocar el token: contraseña corta o común → 400 y el token sigue sirviendo", async () => {
    const { token } = await conToken();
    const corta = await restablecer(token, "Corta-123");
    expect(corta.status).toBe(400);
    expect(corta.body).toEqual({ codigo: "contrasena_invalida", motivo: "longitud" });
    const comun = await restablecer(token, "qwertyuiop12");
    expect(comun.status).toBe(400);
    expect(comun.body).toEqual({ codigo: "contrasena_invalida", motivo: "comun" });
    expect((await restablecer(token)).status).toBe(204);
  });

  it("una contraseña de más de 128 puntos de código se rechaza antes de calcular el hash", async () => {
    const { token } = await conToken();
    const antes = h.hasher.calculos;
    const r = await restablecer(token, "😀".repeat(129));
    expect(r.status).toBe(400);
    expect(r.body.motivo).toBe("longitud");
    expect(h.hasher.calculos).toBe(antes);
  });

  it("restablecer revoca todas las sesiones del usuario, reinicia el bloqueo y avisa al titular (CA-6, P9)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s1 = await h.entrar(u);
    const s2 = await h.entrar(u);
    for (let i = 0; i < 5; i++) await h.login(u.correo, `incorrecta-${i}-Zz`);
    expect((await h.login(u.correo, u.contrasena)).status).toBe(401); // bloqueada

    await solicitar(u.correo);
    await h.correo.esperar(u.correo, 2); // aviso de bloqueo + enlace
    const token = h.correo.tokenDe(u.correo);
    expect((await restablecer(token)).status).toBe(204);

    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s1.cookie })).status).toBe(401);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s2.cookie })).status).toBe(401);
    expect((await h.login(u.correo, NUEVA)).status).toBe(200); // el bloqueo se reinició
    const avisos = await h.correo.esperar(u.correo, 3); // + aviso de cambio de contraseña (P9)
    expect(avisos).toHaveLength(3);
    const ultimo = avisos[avisos.length - 1]!;
    expect(ultimo.texto).not.toContain(NUEVA);
    expect(ultimo.texto).not.toContain(token);
    const [fila] = await h.sql("select count(*)::int as n from auth.intento_login where clave = $1 and fallos > 0", [claveCorreo(u.correo)]);
    expect(fila.n).toBe(0);
  });

  it("el token de un usuario no sirve para otro: la contraseña que cambia es solo la de su dueño", async () => {
    const a = await conToken();
    const b = await h.crearUsuario({ estudios: [] });
    expect((await restablecer(a.token)).status).toBe(204);
    expect((await h.login(b.correo, b.contrasena)).status).toBe(200);
  });
});
