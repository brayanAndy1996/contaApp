/* eslint-disable @typescript-eslint/no-explicit-any -- filas de auth.sesion sin tipo en pruebas */
// Spec 004 · T20a, fase TDD (rojo): O-1 de la revisión T20. `auth.login_exito` no comprueba que la credencial
// siga siendo la que se verificó: un login con la contraseña vieja cuya verificación termina antes de que el
// titular restablezca (o cambie) la contraseña, y cuyo `login_exito` llega después, deja una sesión viva
// (CA-6) y, si el hash necesitaba re-hash, deshace el restablecimiento. Comportamiento correcto fijado aquí:
// ese login es 401 (misma respuesta que credenciales inválidas, sin Set-Cookie), no queda sesión viva por él
// y la credencial vigente es la nueva.
// Carrera determinista por la vía real: el hasher espía del harness (el mismo objeto que usa la app) retiene
// al login justo después de verificar la contraseña vieja y antes de `login_exito`; mientras tanto el titular
// completa POST /auth/recuperar/restablecer o POST /auth/contrasena. Usuarios e IPs únicos; limpia sus filas.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  claveCorreo,
  COOKIE,
  cookieSesion,
  hashViejo,
  ipUnica,
  PWD,
  seedAuth,
  type Harness,
  type Resp,
  type UsuarioPrueba,
} from "../../../test/soporte.js";

let h: Harness;
const S = seedAuth();
const sujetos: string[] = [];
const ip = (): string => {
  const v = ipUnica();
  sujetos.push(v);
  return v;
};
const nuevaContrasena = (): string => `o1-${randomBytes(8).toString("hex")}-Larga`;

beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  if (h) {
    await h.sql("delete from auth.limite_tasa where sujeto = any($1::text[])", [sujetos]).catch(() => undefined);
    await h.cerrar();
  }
});

/**
 * Retiene (una sola vez) al primer login que verifica `vieja` con éxito: la verificación real ya ocurrió y
 * el login queda esperando antes de llamar a `login_exito`. `restaurar()` devuelve el hasher intacto.
 */
function retenerLogin(vieja: string) {
  const original = h.hasher.verificar;
  let soltar!: () => void;
  let llego!: () => void;
  const compuerta = new Promise<void>((r) => (soltar = r));
  const alcanzado = new Promise<void>((r) => (llego = r));
  let armado = true;
  h.hasher.verificar = async (phc, plano) => {
    const ok = await original(phc, plano);
    if (armado && ok && plano === vieja) {
      armado = false;
      llego();
      await compuerta;
    }
    return ok;
  };
  const esperarAlcance = async (): Promise<void> => {
    let t!: NodeJS.Timeout;
    const limite = new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error("el login retenido no llegó a verificar la contraseña vieja")), 15_000);
    });
    try {
      await Promise.race([alcanzado, limite]);
    } finally {
      clearTimeout(t);
    }
  };
  return { soltar, esperarAlcance, restaurar: () => void (h.hasher.verificar = original) };
}

interface Carrera {
  ataque: Resp;
  nueva: string;
  /** Estado HTTP de la operación del titular (debe ser 204). */
  titular: number;
}

/**
 * El atacante inicia un login con `u.contrasena` (la vieja); su verificación termina; el titular completa
 * `via`; solo entonces el login retenido llama a `login_exito`.
 */
async function carrera(u: UsuarioPrueba, via: "restablecer" | "cambio", rehash = false): Promise<Carrera> {
  sujetos.push(claveCorreo(u.correo).toString("hex"));
  const nueva = nuevaContrasena();
  let gate: ReturnType<typeof retenerLogin> | null = null;
  let titular = 0;
  let pendiente: Promise<Resp> | null = null;
  try {
    if (via === "restablecer") {
      const pedido = await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo }, ip: ip() });
      expect(pedido.status, "pedir recuperación").toBe(202);
      await h.correo.esperar(u.correo, 1);
      const token = h.correo.tokenDe(u.correo);
      gate = retenerLogin(u.contrasena);
      pendiente = h.login(u.correo, u.contrasena, { ip: ip() });
      await gate.esperarAlcance();
      titular = (await h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token, contrasena: nueva }, ip: ip() }))
        .status;
    } else {
      const t = await h.entrar(u, { ip: ip() }); // antes de armar la retención: este login no debe quedar retenido
      if (rehash) {
        // `entrar` ya re-calculó el hash: se deja de nuevo uno viejo del mismo secreto para que el ataque lo re-calcule.
        await h.sql("update auth.usuario_contrasena set hash = $2 where usuario_id = $1", [
          u.id,
          await hashViejo(u.contrasena),
        ]);
      }
      gate = retenerLogin(u.contrasena);
      pendiente = h.login(u.correo, u.contrasena, { ip: ip() });
      await gate.esperarAlcance();
      titular = (
        await h.pedir({
          ruta: "/auth/contrasena",
          cuerpo: { actual: u.contrasena, nueva },
          cookie: t.cookie,
          csrf: t.csrf,
          ip: ip(),
        })
      ).status;
    }
  } finally {
    gate?.soltar();
    gate?.restaurar();
  }
  return { ataque: await pendiente!, nueva, titular };
}

/** Lo que debe cumplirse tras la carrera, sea cual sea la vía del titular. */
async function afirmarCorreccion(u: UsuarioPrueba, c: Carrera, vivasEsperadas: number): Promise<void> {
  expect(c.titular, "operación del titular").toBe(204);
  const invalida = await h.login(u.correo, `incorrecta-${randomBytes(6).toString("hex")}-Larga`, { ip: ip() });
  expect(invalida.status).toBe(401);
  // El login con la contraseña vieja que cruzó la carrera es indistinguible de unas credenciales inválidas.
  expect.soft(c.ataque.status, "login con la contraseña vieja tras la carrera").toBe(401);
  expect.soft(c.ataque.body, "cuerpo distinto al de credenciales inválidas").toEqual(invalida.body);
  expect.soft(c.ataque.setCookies, "el login perdedor emite Set-Cookie").toEqual([]);
  const cookie = cookieSesion(c.ataque);
  if (cookie) {
    const s = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${cookie.valor}`, ip: ip() });
    expect.soft(s.status, "la cookie del login perdedor autentica").toBe(401);
  }
  const vivas = (await h.sesiones(u.id)).filter((s: any) => s.revocada_en === null);
  expect.soft(vivas.length, "sesiones vivas del usuario").toBe(vivasEsperadas);
  // La credencial vigente es la nueva.
  const conNueva = await h.login(u.correo, c.nueva, { ip: ip() });
  expect.soft(conNueva.status, "la contraseña nueva debe entrar").toBe(200);
  const conVieja = await h.login(u.correo, u.contrasena, { ip: ip() });
  expect.soft(conVieja.status, "la contraseña vieja no debe entrar").toBe(401);
}

describe("T20a · O-1: login_exito exige la credencial verificada", () => {
  it("O1-01 login con la contraseña vieja que cruza un restablecimiento es 401 y no deja sesión viva (CA-6, CA-2)", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA] });
    const c = await carrera(u, "restablecer");
    await afirmarCorreccion(u, c, 0); // restablecer revoca todas y el login perdedor no crea ninguna
  });

  it("O1-02 login con la contraseña vieja que cruza un cambio de contraseña es 401 y no deja sesión viva (CA-6, P11)", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA] });
    const c = await carrera(u, "cambio");
    // Vive solo la sesión rotada del titular; el login perdedor no crea ninguna.
    await afirmarCorreccion(u, c, 1);
  });

  it("O1-03 con re-hash pendiente, un restablecimiento concurrente no se deshace: la nueva entra y la vieja no (CA-4, CA-6)", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA], hash: await hashViejo(PWD) });
    const c = await carrera(u, "restablecer");
    await afirmarCorreccion(u, c, 0);
  });

  it("O1-04 con re-hash pendiente, un cambio de contraseña concurrente no se deshace: la nueva entra y la vieja no (CA-4, P11)", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA], hash: await hashViejo(PWD) });
    const c = await carrera(u, "cambio", true);
    await afirmarCorreccion(u, c, 1);
  });
});

describe("T20a · O-1: controles positivos (sin carrera, deben seguir en verde)", () => {
  it("O1-C1 login normal: 200, cookie de sesión y una sesión viva", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA] });
    const l = await h.login(u.correo, u.contrasena, { ip: ip() });
    expect(l.status).toBe(200);
    const cookie = cookieSesion(l);
    expect(cookie, "Set-Cookie de sesión").toBeDefined();
    const s = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${cookie!.valor}`, ip: ip() });
    expect(s.status).toBe(200);
    expect((await h.sesiones(u.id)).filter((x: any) => x.revocada_en === null).length).toBe(1);
  });

  it("O1-C2 login normal con hash viejo: entra, re-calcula el hash y la contraseña sigue valiendo", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA], hash: await hashViejo(PWD) });
    const antes = (await h.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0].hash as string;
    expect(antes).toContain("m=8192");
    const l = await h.login(u.correo, u.contrasena, { ip: ip() });
    expect(l.status).toBe(200);
    const despues = (await h.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0].hash as string;
    expect(despues).not.toBe(antes);
    expect(despues).not.toContain("m=8192");
    expect((await h.login(u.correo, u.contrasena, { ip: ip() })).status).toBe(200);
  });

  it("O1-C3 restablecer sin carrera: la nueva entra, la vieja no y no quedan sesiones de antes", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA] });
    sujetos.push(claveCorreo(u.correo).toString("hex"));
    const previa = await h.entrar(u, { ip: ip() });
    expect((await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo }, ip: ip() })).status).toBe(202);
    await h.correo.esperar(u.correo, 1);
    const nueva = nuevaContrasena();
    const r = await h.pedir({
      ruta: "/auth/recuperar/restablecer",
      cuerpo: { token: h.correo.tokenDe(u.correo), contrasena: nueva },
      ip: ip(),
    });
    expect(r.status).toBe(204);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: previa.cookie, ip: ip() })).status).toBe(401);
    expect((await h.login(u.correo, nueva, { ip: ip() })).status).toBe(200);
    expect((await h.login(u.correo, u.contrasena, { ip: ip() })).status).toBe(401);
  });
});
