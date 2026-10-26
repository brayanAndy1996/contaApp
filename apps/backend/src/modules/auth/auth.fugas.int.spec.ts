// T7 (004) · CA-10 (sin fugas, RNF-004) y cabeceras generales. Rojo: `crearApp` aun no existe (T12).
// Con contraseña y tokens canario, ninguno aparece en logs, errores (message, stack, cause), respuestas
// ni cabeceras. Ninguna respuesta incluye un hash (lo verifica además cada `pedir` del soporte).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirHarness, capturarLogs, cookieSesion, COOKIE, pausa, seedAuth, type Harness } from "../../../test/soporte.js";

let h: Harness;
beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  await h?.cerrar();
});

const canario = (p: string) => `${p}-CANARIO-${randomBytes(8).toString("hex")}`;

describe("CA-10 · sin fugas", () => {
  it("la contraseña canario no aparece en logs ni respuestas en login, cambio y restablecimiento", async () => {
    const pwd = canario("Pwd") + "-Zq9";
    const nueva = canario("Nueva") + "-Zq9";
    const restab = canario("Rest") + "-Zq9";
    const u = await h.crearUsuario({ estudios: [seedAuth().tenantA], contrasena: pwd });
    const { resultado, logs } = await capturarLogs(async () => {
      const textos: string[] = [];
      const guardar = (r: { text: string; headers: unknown }) => textos.push(r.text, JSON.stringify(r.headers));
      guardar(await h.login(u.correo, pwd + "x")); // fallo con el canario casi exacto
      const l = await h.login(u.correo, pwd);
      guardar(l);
      const s = await h.entrar({ correo: u.correo, contrasena: pwd });
      guardar(await h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: pwd, nueva: "corta" }, cookie: s.cookie, csrf: s.csrf }));
      guardar(await h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: pwd + "mal", nueva }, cookie: s.cookie, csrf: s.csrf }));
      const c = await h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual: pwd, nueva }, cookie: s.cookie, csrf: s.csrf });
      guardar(c);
      await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo } });
      await h.correo.esperar(u.correo, 1);
      guardar(await h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token: h.correo.tokenDe(u.correo), contrasena: restab } }));
      await pausa(300);
      return textos.join("\n");
    });
    for (const secreto of [pwd, nueva, restab]) {
      expect(resultado).not.toContain(secreto);
      expect(logs).not.toContain(secreto);
    }
  });

  it("el token de recuperación no aparece en logs ni en respuestas (solo viaja por el correo)", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const { resultado, logs } = await capturarLogs(async () => {
      const r = await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo } });
      await h.correo.esperar(u.correo, 1);
      const token = h.correo.tokenDe(u.correo);
      const rest = await h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token, contrasena: "corta" } });
      const rest2 = await h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token, contrasena: "Contrasena-restablecida-004-kQ" } });
      await pausa(300);
      return { token, vistos: [r.text, rest.text, rest2.text, JSON.stringify([r.headers, rest.headers, rest2.headers])].join("\n") };
    });
    expect(resultado.vistos).not.toContain(resultado.token);
    expect(logs).not.toContain(resultado.token);
  });

  it("el token de sesión y el CSRF no aparecen en logs ni en cuerpos de error", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const { resultado: s, logs } = await capturarLogs(async () => {
      const sesion = await h.entrar(u);
      await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seedAuth().tenantA }, cookie: sesion.cookie }); // 403 csrf
      await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seedAuth().tenantA }, cookie: sesion.cookie, csrf: sesion.csrf, origen: "https://evil.example" });
      await pausa(200);
      return sesion;
    });
    expect(logs).not.toContain(s.valor);
    expect(logs).not.toContain(s.csrf);
  });

  it("un error interno con la contraseña en message, stack y cause responde solo {codigo} y no se registra", async () => {
    const pwd = canario("Pwd") + "-Zq9";
    const u = await h.crearUsuario({ estudios: [], contrasena: pwd });
    h.hasher.fallaVerificar = (plano) => {
      const causa = new Error(`causa con ${plano}`);
      const e = new Error(`fallo verificando ${plano}`, { cause: causa });
      e.stack = `Error: ${plano}\n    at ${plano}`;
      return e;
    };
    try {
      const { resultado: r, logs } = await capturarLogs(async () => {
        const x = await h.login(u.correo, pwd);
        await pausa(200);
        return x;
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys(r.body)).toEqual(["codigo"]);
      expect(r.setCookies).toEqual([]);
      expect(`${r.text}${JSON.stringify(r.headers)}`).not.toContain(pwd);
      expect(logs).not.toContain(pwd);
    } finally {
      h.hasher.fallaVerificar = null;
    }
  });

  it("un correo que falla con el token en message, stack y cause no filtra nada y no rompe la respuesta", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const marca = canario("Tok");
    h.correo.fallar = new Error(`SMTP rechazó ${marca}`, { cause: new Error(marca) });
    try {
      const { resultado: r, logs } = await capturarLogs(async () => {
        const x = await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo } });
        await pausa(300);
        return x;
      });
      expect(r.status).toBe(202);
      expect(logs).not.toContain(marca);
    } finally {
      h.correo.fallar = null;
    }
  });

  it("un hash corrupto en BD no se filtra: respuesta sin el hash ni su contenido", async () => {
    const marca = canario("H").replace(/[^A-Za-z0-9]/g, "");
    const u = await h.crearUsuario({ estudios: [], hash: `$argon2id$v=19$m=19456,t=2,p=1$${marca}$${marca}` });
    const { resultado: r, logs } = await capturarLogs(async () => {
      const x = await h.login(u.correo, "Contrasena-cualquiera-1");
      await pausa(200);
      return x;
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.text).not.toContain(marca);
    expect(logs).not.toContain(marca);
    expect(r.setCookies).toEqual([]);
  });

  it("los errores no repiten la entrada: ni correo ni campos extra ni rutas con canario", async () => {
    const marca = canario("Eco");
    const rs = [
      await h.pedir({ ruta: "/auth/login", cuerpo: { correo: `${marca}@t004.contapp.test`, contrasena: [marca] } }),
      await h.pedir({ ruta: "/auth/login", crudo: `{"correo": "${marca}"` }), // JSON roto
      await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: marca } }),
      await h.pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token: marca, contrasena: marca } }),
      await h.pedir({ ruta: `/auth/${marca}` }),
      await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${marca}` }),
    ];
    for (const r of rs) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.text).not.toContain(marca);
      expect(JSON.stringify(r.headers)).not.toContain(marca);
    }
    // Todos los errores de negocio tienen la forma { codigo } (y `motivo` en contrasena_invalida).
    for (const r of rs.filter((x) => x.status !== 404)) {
      expect(typeof r.body.codigo).toBe("string");
      expect(Object.keys(r.body).filter((k) => !["codigo", "motivo"].includes(k))).toEqual([]);
    }
  });
});

describe("Cabeceras generales (plan: Contratos HTTP)", () => {
  it("todas las respuestas llevan Cache-Control: no-store y no revelan x-powered-by", async () => {
    const u = await h.crearUsuario({ estudios: [seedAuth().tenantA] });
    const s = await h.entrar(u);
    const respuestas = [
      await h.login(u.correo, u.contrasena),
      await h.login(u.correo, "Contrasena-equivocada-1"),
      await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie }),
      await h.pedir({ ruta: "/auth/sesion" }),
      await h.pedir({ ruta: "/auth/estudios", cookie: s.cookie }),
      await h.pedir({ ruta: "/estudio/actual", cookie: s.cookie, estudio: seedAuth().tenantA }),
      await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: seedAuth().tenantA }, cookie: s.cookie }), // 403
      await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo } }),
    ];
    for (const r of respuestas) {
      expect(r.headers["cache-control"]).toMatch(/no-store/);
      expect(r.headers["x-powered-by"]).toBeUndefined();
    }
  });

  it("la cookie de sesión nunca se emite en errores ni en rutas de solo lectura", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await h.entrar(u);
    for (const r of [
      await h.login(u.correo, "Contrasena-equivocada-1"),
      await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie }),
      await h.pedir({ ruta: "/auth/estudios", cookie: s.cookie }),
      await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo } }),
    ]) {
      expect(cookieSesion(r)).toBeUndefined();
    }
  });
});
