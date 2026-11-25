/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// T3 (029) · CA-6 (secretos, RNF-004: canarios en logs, errores, auditoría, eventos, correos y respuestas) y CA-10 (un aviso por evento de
// U8, sin código, secreto ni enlace). Los canarios son el secreto, el URI, los códigos TOTP buenos y malos, los de recuperación, la contraseña
// y la clave `TOTP_CLAVE`. Rojo: rutas `/auth/totp/*`, `/auth/2fa/verificar` y tablas de 0078 aún no existen (T5, T7).
import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { capturarLogs, COOKIE, cookieSesion, pausa, type Harness } from "../../../test/soporte.js";
import {
  abrirHarnessTotp,
  activarTotp,
  base32Decode,
  codigoErroneo,
  congelarReloj,
  entrarSinTotp,
  loginPendiente,
  secretoDeUri,
  TOTP_CLAVE_PRUEBA,
  verificar,
  visible,
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

const canario = (p: string) => `${p}-CANARIO-${randomBytes(8).toString("hex")}`;
/** Un código de 6 dígitos suelto (sin letras, dígitos ni guiones pegados): evita falsos positivos con UUID o marcas de tiempo. */
const contieneCodigo = (texto: string, codigo: string) => new RegExp(`(?<![0-9A-Za-z-])${codigo}(?![0-9A-Za-z-])`).test(texto);

interface Visto {
  ruta: string;
  estado: number;
  texto: string;
}
/** Registra cada respuesta que pasa por `h.pedir` (para revisar todo lo observable por el cliente). */
function espiar(): { vistos: Visto[]; soltar: () => void } {
  const original = h.pedir.bind(h);
  const vistos: Visto[] = [];
  h.pedir = async (p) => {
    const r = await original(p);
    vistos.push({ ruta: `${p.metodo ?? (p.cuerpo !== undefined ? "POST" : "GET")} ${p.ruta}`, estado: r.status, texto: visible(r) });
    return r;
  };
  return { vistos, soltar: () => (h.pedir = original) };
}

const volcado = async (tabla: string): Promise<string> =>
  (await h.sql(`select coalesce(string_agg(to_jsonb(t)::text, E'\\n'), '') as texto from ${tabla} t`))[0].texto;

describe("CA-6 · ningún canario sale por logs, respuestas, correos ni tablas legibles", () => {
  it("flujo completo (enrolar, confirmar, verificar bueno y malo, recuperación, regenerar, desactivar) sin fugas fuera de donde el contrato las permite", async () => {
    reloj = congelarReloj();
    const pwd = canario("Pwd") + "-Zq9";
    const u = await h.crearUsuario({ estudios: [], contrasena: pwd });
    const espia = espiar();
    const malos: string[] = [];
    let secreto = "";
    let uri = "";
    let codigos1: string[] = [];
    let codigos2: string[] = [];
    const buenos: string[] = [];
    let mailsAntes = 0;
    const { logs } = await capturarLogs(async () => {
      try {
        const cuenta = await activarTotp(h, u, reloj);
        secreto = cuenta.secreto;
        uri = cuenta.uri;
        codigos1 = cuenta.codigos;
        buenos.push(reloj.codigo(secreto));
        // Segundo paso: erróneos de TOTP y de recuperación, luego uno bueno de TOTP y uno de recuperación.
        reloj.avanzar(1);
        const p = await loginPendiente(h, u);
        for (let i = 0; i < 2; i++) {
          const mal = codigoErroneo(secreto, reloj.ahora());
          malos.push(mal);
          await verificar(h, p, { codigo: mal });
        }
        await verificar(h, p, { codigoRecuperacion: "AAAA-AAAA-AAAA" });
        await verificar(h, p, { codigo: canario("eco") });
        buenos.push(reloj.codigo(secreto));
        await verificar(h, p, { codigo: buenos[1]! });
        reloj.avanzar(1);
        const q = await loginPendiente(h, u);
        await verificar(h, q, { codigoRecuperacion: codigos1[0]! });
        // Sesión verificada: regenerar y desactivar (la cuenta no tiene estudios ni es plataforma: no hay exigencia).
        reloj.avanzar(1);
        const v = await loginPendiente(h, u);
        buenos.push(reloj.codigo(secreto));
        const ok = await verificar(h, v, { codigo: buenos[2]! });
        const sesionOk = { cookie: `${COOKIE}=${cookieSesion(ok)!.valor}`, csrf: "" };
        sesionOk.csrf = (await h.pedir({ ruta: "/auth/sesion", cookie: sesionOk.cookie })).body.csrf;
        reloj.avanzar(1);
        buenos.push(reloj.codigo(secreto));
        const reg = await h.pedir({ ruta: "/auth/totp/recuperacion", cuerpo: { contrasena: pwd, codigo: buenos[3]! }, cookie: sesionOk.cookie, csrf: sesionOk.csrf });
        codigos2 = reg.body.codigosRecuperacion ?? [];
        await h.pedir({ ruta: "/auth/totp/desactivar", cuerpo: { contrasena: pwd + "x", codigo: "000000" }, cookie: sesionOk.cookie, csrf: sesionOk.csrf });
        reloj.avanzar(1);
        buenos.push(reloj.codigo(secreto));
        await h.pedir({ ruta: "/auth/totp/desactivar", cuerpo: { contrasena: pwd, codigo: buenos[4]! }, cookie: sesionOk.cookie, csrf: sesionOk.csrf });
        mailsAntes = h.correo.para(u.correo).length;
        await pausa(400);
      } finally {
        espia.soltar();
      }
    });
    expect(secreto).toMatch(/^[A-Z2-7]{32}$/);
    expect(codigos1).toHaveLength(10);
    expect(codigos2).toHaveLength(10);

    // 1) Respuestas: el secreto y el URI solo viajan en la de enrolar; los códigos de recuperación, solo en la de confirmar y en la de regenerar.
    for (const v of espia.vistos) {
      if (!v.ruta.endsWith("/auth/totp/enrolar") || v.estado !== 200) {
        expect(v.texto, v.ruta).not.toContain(secreto);
        expect(v.texto, v.ruta).not.toContain(uri);
        expect(v.texto, v.ruta).not.toMatch(/otpauth:/);
      }
      if (!(v.estado === 200 && (v.ruta.endsWith("/auth/totp/confirmar") || v.ruta.endsWith("/auth/totp/recuperacion")))) {
        for (const c of [...codigos1, ...codigos2]) expect(v.texto, v.ruta).not.toContain(c);
      }
      expect(v.texto, v.ruta).not.toContain(pwd);
      expect(v.texto, v.ruta).not.toContain(TOTP_CLAVE_PRUEBA!.split(":")[1]!);
    }
    // 2) Logs.
    for (const s of [secreto, uri, pwd, ...codigos1, ...codigos2, TOTP_CLAVE_PRUEBA!.split(":")[1]!]) expect(logs).not.toContain(s);
    expect(logs).not.toMatch(/otpauth:/);
    for (const c of [...malos, ...buenos]) expect(contieneCodigo(logs, c), `código ${c} en logs`).toBe(false);
    // 3) Correos (U8).
    const mails = h.correo.para(u.correo);
    expect(mails.length).toBeGreaterThanOrEqual(1);
    for (const m of mails) {
      const t = `${m.asunto}\n${m.texto}`;
      for (const s of [secreto, uri, pwd, ...codigos1, ...codigos2]) expect(t).not.toContain(s);
      expect(t).not.toMatch(/otpauth:|https?:\/\/|#t=|secret=/i);
      for (const c of [...malos, ...buenos]) expect(contieneCodigo(t, c)).toBe(false);
    }
    // 4) Tablas legibles por quien las vuelque: auditoría, eventos, sesiones y contadores no guardan secretos.
    for (const tabla of ["auth.cuenta_evento", "auth.sesion", "auth.intento_login", "auth.limite_tasa", "auditoria", "notificacion"]) {
      const t = await volcado(tabla).catch(() => "");
      for (const s of [secreto, uri, pwd, ...codigos1, ...codigos2]) expect(t, tabla).not.toContain(s);
    }
    expect(mailsAntes).toBeGreaterThanOrEqual(1);
  });

  it("un volcado de auth.totp y auth.totp_recuperacion no permite generar códigos ni probar los de recuperación (D1)", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const cuenta = await activarTotp(h, u, reloj);
    const totp = await volcado("auth.totp");
    const rec = await volcado("auth.totp_recuperacion");
    const bytes = base32Decode(cuenta.secreto);
    for (const forma of [cuenta.secreto, cuenta.secreto.toLowerCase(), bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url"), cuenta.uri]) {
      expect(totp).not.toContain(forma);
      expect(rec).not.toContain(forma);
    }
    const filas = await h.sql("select hash from auth.totp_recuperacion where usuario_id = $1", [u.id]);
    expect(filas).toHaveLength(10);
    for (const c of cuenta.codigos) {
      expect(rec).not.toContain(c);
      expect(rec).not.toContain(c.replace(/-/g, ""));
      // No es un hash simple: sin la clave del backend no se pueden probar candidatos.
      for (const v of [c, c.replace(/-/g, ""), c.toLowerCase(), c.replace(/-/g, "").toLowerCase()]) {
        const simple = createHash("sha256").update(v).digest();
        expect(filas.some((f: any) => Buffer.from(f.hash).equals(simple))).toBe(false);
      }
    }
    expect(new Set(filas.map((f: any) => Buffer.from(f.hash).toString("hex"))).size).toBe(10);
    const [fila] = await h.sql("select activo_cifrado from auth.totp where usuario_id = $1", [u.id]);
    expect(Buffer.from(fila.activo_cifrado).length).toBeGreaterThan(bytes.length); // cifrado con nonce y etiqueta, no el secreto
    expect(Buffer.from(fila.activo_cifrado).includes(bytes)).toBe(false);
  });

  it("el rol del backend no lee ni escribe las tablas nuevas (solo por funciones): permission denied, sin datos en el mensaje", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    await activarTotp(h, u, reloj);
    const consultas: Array<[string, string, string]> = [
      ["auth.totp", "select * from auth.totp", "update auth.totp set usuario_id = usuario_id"],
      ["auth.totp_recuperacion", "select * from auth.totp_recuperacion", "update auth.totp_recuperacion set usuario_id = usuario_id"],
      ["auth.cuenta_evento", "select * from auth.cuenta_evento", "update auth.cuenta_evento set usuario_id = usuario_id"],
    ];
    for (const [tabla, leer, escribir] of consultas) {
      for (const texto of [leer, escribir]) {
        const e = await h.dbBackend.pool.query(texto).then(
          () => null,
          (x: Error) => x,
        );
        expect(e, `${tabla}: ${texto}`).not.toBeNull();
        expect(e!.message).toMatch(/permission denied|permiso denegado/i);
      }
    }
  });

  it("una entrada inválida con canario no se refleja ni se registra: 400 sin eco en todas las rutas con cuerpo", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    const s = await entrarSinTotp(h, u);
    const marca = canario("Eco");
    const { resultado, logs } = await capturarLogs(async () => {
      const rs = [];
      for (const ruta of ["/auth/totp/enrolar", "/auth/totp/confirmar", "/auth/totp/desactivar", "/auth/totp/recuperacion"]) {
        rs.push(await h.pedir({ ruta, cuerpo: { contrasena: [marca], codigo: marca, [marca]: marca }, cookie: s.cookie, csrf: s.csrf }));
      }
      rs.push(await h.pedir({ ruta: "/auth/2fa/verificar", cuerpo: { codigo: marca, codigoRecuperacion: marca }, cookie: s.cookie, csrf: s.csrf }));
      rs.push(await h.pedir({ ruta: "/auth/totp/confirmar", crudo: `{"codigo": "${marca}"`, cookie: s.cookie, csrf: s.csrf })); // JSON roto
      await pausa(300);
      return rs;
    });
    for (const r of resultado) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(visible(r)).not.toContain(marca);
    }
    expect(logs).not.toContain(marca);
  });
});

describe("CA-10 · un aviso por evento de U8, sin código, secreto ni enlace de acción", () => {
  it("activar, usar un código de recuperación y desactivar mandan un correo cada uno; regenerar y los códigos erróneos no", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const n = () => h.correo.para(u.correo).length;
    expect(n()).toBe(0);

    const cuenta = await activarTotp(h, u, reloj);
    expect((await h.correo.esperar(u.correo, 1)).length).toBe(1); // totp activado

    reloj.avanzar(1);
    const p = await loginPendiente(h, u);
    await verificar(h, p, { codigo: codigoErroneo(cuenta.secreto, reloj.ahora()) });
    await pausa(300);
    expect(n()).toBe(1); // un código erróneo no avisa

    await verificar(h, p, { codigoRecuperacion: cuenta.codigos[0]! });
    expect((await h.correo.esperar(u.correo, 2)).length).toBe(2); // recuperación usada
    await pausa(300);
    expect(n()).toBe(2);

    reloj.avanzar(1);
    const q = await loginPendiente(h, u);
    const ok = await verificar(h, q, { codigo: reloj.codigo(cuenta.secreto) });
    expect(ok.status).toBe(200);
    const sesion = { cookie: `${COOKIE}=${cookieSesion(ok)!.valor}`, csrf: "" };
    sesion.csrf = (await h.pedir({ ruta: "/auth/sesion", cookie: sesion.cookie })).body.csrf;
    reloj.avanzar(1);
    const reg = await h.pedir({ ruta: "/auth/totp/recuperacion", cuerpo: { contrasena: u.contrasena, codigo: reloj.codigo(cuenta.secreto) }, cookie: sesion.cookie, csrf: sesion.csrf });
    expect(reg.status).toBe(200);
    await pausa(300);
    expect(n()).toBe(2); // regenerar no está en U8

    reloj.avanzar(1);
    const des = await h.pedir({ ruta: "/auth/totp/desactivar", cuerpo: { contrasena: u.contrasena, codigo: reloj.codigo(cuenta.secreto) }, cookie: sesion.cookie, csrf: sesion.csrf });
    expect(des.status).toBe(204);
    expect((await h.correo.esperar(u.correo, 3)).length).toBe(3); // totp desactivado

    for (const m of h.correo.para(u.correo)) {
      expect(m.asunto.length).toBeGreaterThan(0);
      expect(m.para.toLowerCase()).toBe(u.correo.toLowerCase());
      expect(`${m.asunto}\n${m.texto}`).not.toMatch(/https?:\/\/|#t=|otpauth:|secret=/i);
    }
    // Los tres avisos son distintos entre sí (un evento, un texto).
    expect(new Set(h.correo.para(u.correo).map((m) => m.asunto)).size).toBe(3);
  });

  it("si el correo falla, la operación no falla y el error no filtra nada (el aviso es de mejor esfuerzo)", async () => {
    reloj = congelarReloj();
    const u = await h.crearUsuario({ estudios: [] });
    const marca = canario("Smtp");
    const s = await entrarSinTotp(h, u);
    const enrolar = await h.pedir({ ruta: "/auth/totp/enrolar", cuerpo: { contrasena: u.contrasena }, cookie: s.cookie, csrf: s.csrf });
    const secreto = secretoDeUri(enrolar.body.uri);
    h.correo.fallar = new Error(`SMTP rechazó ${marca}`, { cause: new Error(marca) });
    try {
      const { resultado: r, logs } = await capturarLogs(async () => {
        const x = await h.pedir({ ruta: "/auth/totp/confirmar", cuerpo: { codigo: reloj.codigo(secreto) }, cookie: s.cookie, csrf: s.csrf });
        await pausa(400);
        return x;
      });
      expect(r.status).toBe(200);
      expect(visible(r)).not.toContain(marca);
      expect(logs).not.toContain(marca);
      expect(logs).not.toContain(secreto);
    } finally {
      h.correo.fallar = null;
    }
  });
});
