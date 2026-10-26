// T7 (004) · CA-3 (bloqueo RF-015, límite por IP, aviso P3/P13). Rojo: `crearApp` aun no existe (T12).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  claveCorreo,
  forma,
  ipUnica,
  pausa,
  type Harness,
} from "../../../test/soporte.js";

let h: Harness;
beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  await h?.cerrar();
});

const fallar = async (correo: string, veces: number) => {
  const rs = [];
  for (let i = 0; i < veces; i++) rs.push(await h.login(correo, `incorrecta-${i}-Zz`));
  return rs;
};

describe("CA-3 · bloqueo por fallos (RF-015)", () => {
  it("el 5.º fallo en 15 min bloquea la cuenta 15 min y la contraseña correcta también se rechaza", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const fallos = await fallar(u.correo, 5);
    expect(fallos.every((r) => r.status === 401)).toBe(true);

    const [fila] = await h.sql(
      "select extract(epoch from (bloqueado_hasta - now())) as seg from auth.intento_login where clave = $1",
      [claveCorreo(u.correo)],
    );
    expect(Number(fila.seg)).toBeGreaterThan(14 * 60);
    expect(Number(fila.seg)).toBeLessThanOrEqual(15 * 60 + 5);

    const correcta = await h.login(u.correo, u.contrasena);
    expect(correcta.status).toBe(401);
    expect(correcta.body).toEqual({ codigo: "credenciales_invalidas" });
    expect(correcta.setCookies).toEqual([]);
    expect(forma(correcta)).toEqual(forma(fallos[0]!));
    expect(await h.sesiones(u.id)).toHaveLength(0);
  });

  it("el bloqueo se levanta esperando los 15 min (marca de tiempo movida con la conexión de migraciones)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    await fallar(u.correo, 5);
    await h.sql(
      "update auth.intento_login set bloqueado_hasta = now() - interval '1 minute', ventana_inicio = now() - interval '16 minutes' where clave = $1",
      [claveCorreo(u.correo)],
    );
    expect((await h.login(u.correo, u.contrasena)).status).toBe(200);
  });

  it("con 4 fallos todavía entra y un éxito reinicia el contador", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    await fallar(u.correo, 4);
    expect((await h.login(u.correo, u.contrasena)).status).toBe(200);
    const [fila] = await h.sql("select fallos from auth.intento_login where clave = $1", [claveCorreo(u.correo)]);
    expect(fila === undefined || fila.fallos === 0).toBe(true);
    await fallar(u.correo, 4); // otros 4: no bloquea porque el contador se reinició
    expect((await h.login(u.correo, u.contrasena)).status).toBe(200);
  });

  it("20 intentos fallidos concurrentes no hacen más de 5 verificaciones antes del bloqueo (contador atómico)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const antes = h.hasher.marca();
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => h.login(u.correo, `incorrecta-${i}-Zz`)),
    );
    expect(rs.every((r) => r.status === 401)).toBe(true);
    const reales = h.hasher.reales - antes.reales;
    expect(reales).toBeLessThanOrEqual(5);
    expect(reales).toBeGreaterThan(0);
    // Y la cuenta quedó bloqueada: la contraseña correcta se rechaza.
    expect((await h.login(u.correo, u.contrasena)).status).toBe(401);
  });

  it("los correos inexistentes también acumulan intentos y no cambian de respuesta al bloquearse", async () => {
    const c = h.correoInexistente();
    const rs = await fallar(c, 6);
    expect(rs.every((r) => r.status === 401)).toBe(true);
    for (const r of rs) expect(forma(r)).toEqual(forma(rs[0]!));
    const [fila] = await h.sql("select fallos, bloqueado_hasta from auth.intento_login where clave = $1", [claveCorreo(c)]);
    expect(fila).toBeDefined();
    expect(fila.bloqueado_hasta).not.toBeNull();
  });

  it("las variantes de mayúsculas y espacios del correo comparten el mismo contador", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    for (let i = 0; i < 5; i++) {
      const variante = [u.correo, ` ${u.correo.toUpperCase()}`, `${u.correo} `, u.correo.toUpperCase(), ` ${u.correo}\t`][i]!;
      await h.login(variante, `incorrecta-${i}-Zz`);
    }
    expect((await h.login(u.correo, u.contrasena)).status).toBe(401);
  });
});

describe("CA-3 · límite por IP (D7)", () => {
  it("el 21.º intento de login desde una IP en 10 min recibe 429 demasiados_intentos", async () => {
    const ip = ipUnica();
    for (let i = 0; i < 20; i++) {
      const r = await h.login(h.correoInexistente(), "Contrasena-cualquiera-1", { ip });
      expect(r.status).toBe(401);
    }
    const r = await h.login(h.correoInexistente(), "Contrasena-cualquiera-1", { ip });
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ codigo: "demasiados_intentos" });
    expect(r.setCookies).toEqual([]);
    // Otra IP no se ve afectada.
    expect((await h.login(h.correoInexistente(), "Contrasena-cualquiera-1")).status).toBe(401);
  });

  it("IPv6 se agrupa por prefijo /64 y una IPv4 mapeada cuenta como la IPv4", async () => {
    const base = "2001:db8:abcd:12";
    for (let i = 0; i < 20; i++) {
      const r = await h.login(h.correoInexistente(), "Contrasena-cualquiera-1", { ip: `${base}::${i + 1}` });
      expect(r.status).toBe(401);
    }
    const r = await h.login(h.correoInexistente(), "Contrasena-cualquiera-1", { ip: `${base}:ffff:ffff:ffff:ffff` });
    expect(r.status).toBe(429);

    const v4 = ipUnica();
    for (let i = 0; i < 20; i++) await h.login(h.correoInexistente(), "Contrasena-cualquiera-1", { ip: v4 });
    const mapeada = await h.login(h.correoInexistente(), "Contrasena-cualquiera-1", { ip: `::ffff:${v4}` });
    expect(mapeada.status).toBe(429);
  });
});

describe("CA-3 · aviso de bloqueo al titular (P3, P13)", () => {
  it("al bloquearse una cuenta existente se avisa al titular, fuera de la petición, y solo una vez en 24 h", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    h.correo.retenido = true; // el envío queda colgado: la respuesta no debe esperarlo
    try {
      const rs = await fallar(u.correo, 5);
      expect(rs[4]!.status).toBe(401);
      await pausa(150);
      expect(h.correo.para(u.correo)).toHaveLength(0); // aún no se completó el envío
    } finally {
      h.correo.liberar();
    }
    const avisos = await h.correo.esperar(u.correo, 1);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.para.toLowerCase()).toBe(u.correo);
    expect(avisos[0]!.texto).not.toContain(u.contrasena);

    // Se vence el bloqueo y se vuelve a bloquear dentro de las 24 h: no hay segundo aviso.
    await h.sql(
      "update auth.intento_login set bloqueado_hasta = now() - interval '1 minute', ventana_inicio = now() - interval '16 minutes' where clave = $1",
      [claveCorreo(u.correo)],
    );
    await fallar(u.correo, 5);
    await pausa(300);
    expect(h.correo.para(u.correo)).toHaveLength(1);

    // Pasadas 24 h desde el último aviso, el siguiente bloqueo avisa de nuevo.
    await h.sql(
      "update auth.intento_login set bloqueado_hasta = now() - interval '1 minute', ventana_inicio = now() - interval '16 minutes', aviso_enviado_en = now() - interval '25 hours' where clave = $1",
      [claveCorreo(u.correo)],
    );
    await fallar(u.correo, 5);
    expect(await h.correo.esperar(u.correo, 2)).toHaveLength(2);
  });

  it("un correo inexistente que se bloquea no envía ningún correo", async () => {
    const c = h.correoInexistente();
    await fallar(c, 6);
    await pausa(300);
    expect(h.correo.para(c)).toHaveLength(0);
  });

  it("si el envío falla, la respuesta de login no cambia y no hay error visible", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    h.correo.fallar = new Error("SMTP caído");
    try {
      const rs = await fallar(u.correo, 5);
      expect(rs.every((r) => r.status === 401)).toBe(true);
      for (const r of rs) expect(forma(r)).toEqual(forma(rs[0]!));
      await pausa(200);
    } finally {
      h.correo.fallar = null;
    }
  });

  it("el administrador no desbloquea: solo restablecer la contraseña reinicia el bloqueo (P4)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    await fallar(u.correo, 5);
    expect((await h.login(u.correo, u.contrasena)).status).toBe(401);
    const sol = await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo } });
    expect(sol.status).toBe(202);
    await h.correo.esperar(u.correo, 2); // aviso de bloqueo + correo de recuperación
    const token = h.correo.tokenDe(u.correo);
    const nueva = "Otra-contrasena-004-xyz";
    const rest = await h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token, contrasena: nueva } });
    expect(rest.status).toBe(204);
    expect((await h.login(u.correo, nueva)).status).toBe(200);
  });
});
