// 006 T12a · Ronda adversarial 1a del registro público, CAJA NEGRA (CA-3, CA-4, CA-11; D3, D12).
// Escrita solo con spec, plan (Contratos: HTTP) y los soportes de prueba: sin leer la implementación.
// Cada prueba que falla es un hallazgo. Canarios sintéticos; limpia lo que crea (pendientes, cuentas, estudios,
// filas de `auth.limite_tasa` de sus IPs y correos).
import { randomBytes, randomUUID } from "node:crypto";
import { hash as argonHash } from "@node-rs/argon2";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  capturarLogs,
  claveCorreo,
  ipUnica,
  ORIGEN,
  seedAuth,
  sha256,
  type Resp,
} from "../../../test/soporte.js";
import { abrirBancoPlanes, type BancoPlanes } from "../../../test/soporte-planes.js";

const CONTRASENA = "Canario-adv-t12a-ñ-Wx81";
const ESTUDIO = "Estudio Adv T12a";
const NOMBRE = "Dueño Adv T12a";
let p: BancoPlanes;
const h = () => p.b.h;
const ips: string[] = [];
const correosLimite: string[] = [];

beforeAll(async () => {
  p = await abrirBancoPlanes();
});
afterAll(async () => {
  // Solo las filas de límite de este archivo (T12b corre en paralelo: nunca se borra por tipo).
  if (p) {
    const sujetos = new Set<string>();
    for (const v of [...ips, ...correosLimite]) {
      sujetos.add(v);
      sujetos.add(v.trim().toLowerCase());
      sujetos.add(sha256(v).toString("hex"));
      sujetos.add(sha256(v).toString("base64"));
      sujetos.add(claveCorreo(v).toString("hex"));
      sujetos.add(claveCorreo(v).toString("base64"));
    }
    await p
      // Ajuste de 006 (T13a): D15 agrega `registro_confirmar_ip`; `ip_invalida` es la cubeta de las IP que no lo son (b6).
      .sql(
        "delete from auth.limite_tasa where tipo in ('registro_ip', 'registro_correo', 'registro_confirmar_ip') and sujeto = any($1)",
        [[...sujetos, "ip_invalida"]],
      )
      .catch(() => undefined);
    await p.cerrar();
  }
});

/* ---------------------------------- utilidades ---------------------------------- */
const ip = (): string => {
  const v = ipUnica();
  ips.push(v);
  return v;
};
const correoNuevo = (): string => {
  const c = p.correoRegistro();
  correosLimite.push(c);
  return c;
};
const solicitar = (cuerpo: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  h().pedir({ ruta: "/registro", cuerpo, ip: ip(), ...extra });
const cuerpoBase = (correo: string, o: Record<string, unknown> = {}) => ({ estudio: ESTUDIO, nombre: NOMBRE, correo, ...o });
const consultar = (token: string) => h().pedir({ ruta: "/registro/consultar", cuerpo: { token } });
// Ajuste de 006 (T13a, D15): cada confirmacion sale de una IP propia y rastreada (limite de 10 por hora por IP, y limpieza).
const confirmar = (token: string, extra: Record<string, unknown> = {}) =>
  h().pedir({ ruta: "/registro/confirmar", cuerpo: { token, contrasena: CONTRASENA, ...extra }, ip: ip() });
const tokensDe = (correo: string): string[] =>
  h()
    .correo.para(correo)
    .map((m) => /#t=([A-Za-z0-9_-]+)/.exec(m.texto)?.[1])
    .filter((t): t is string => typeof t === "string");
async function registrar(correo: string, o: Record<string, unknown> = {}) {
  const antes = h().correo.para(correo).length;
  const r = await solicitar(cuerpoBase(correo, o));
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  await h().correo.esperar(correo, antes + 1);
  const ts = tokensDe(correo);
  expect(ts.length).toBeGreaterThan(antes);
  return ts[ts.length - 1]!;
}
async function cuentaExistente() {
  const u = await h().crearUsuario({ estudios: [] });
  p.rastrearRegistro(u.correo);
  correosLimite.push(u.correo);
  return u;
}
const pendientes = (correo: string) =>
  p.sql("select * from auth.registro_pendiente where lower(correo) = lower($1) order by creada_en, id", [correo]);
const estudiosDe = (usuarioId: string) =>
  p.sql(
    `select m.tenant_id, m.rol, s.estado, pl.codigo, s.rucs_extra_contratados,
            extract(epoch from (s.prueba_vence_en - now())) / 86400 as dias
       from membresia m left join suscripcion s on s.tenant_id = m.tenant_id left join plan pl on pl.id = s.plan_id
      where m.usuario_id = $1 order by m.tenant_id`,
    [usuarioId],
  );
const usuarioPorCorreo = async (correo: string): Promise<string[]> =>
  (await p.sql<{ id: string }>("select id from usuario where lower(email) = lower($1)", [correo])).map((f) => f.id);
const no5xx = (r: Resp, que: string) => expect(r.status, `${que}: ${r.status} ${r.text.slice(0, 200)}`).toBeLessThan(500);

/* ================================ Correo: enlace y contenido ================================ */
describe("T12a · el correo del enlace no se puede envenenar", () => {
  it("A1 · Host / X-Forwarded-Host / Forwarded falsos no cambian el origen del enlace (siempre APP_ORIGIN)", async () => {
    const correo = correoNuevo();
    const r = await solicitar(cuerpoBase(correo), {
      cabeceras: {
        Host: "evil-t12a.example",
        "X-Forwarded-Host": "evil-t12a.example",
        "X-Forwarded-Proto": "http",
        "X-Forwarded-Port": "6666",
        Forwarded: "for=1.2.3.4;host=evil-t12a.example;proto=http",
        "X-Original-Host": "evil-t12a.example",
      },
    });
    no5xx(r, "solicitud");
    if (r.status === 202) {
      const ms = await h().correo.esperar(correo, 1);
      expect(ms).toHaveLength(1);
      const texto = `${ms[0]!.asunto}\n${ms[0]!.texto}`;
      expect(texto).not.toContain("evil-t12a");
      expect(texto).not.toContain("6666");
      const enlaces = texto.match(/https?:\/\/[^\s<>"')]+/g) ?? [];
      expect(enlaces.length).toBeGreaterThan(0);
      for (const e of enlaces) expect(e.startsWith(`${ORIGEN}/`), e).toBe(true);
    }
  });

  it("A2 · un visitante anónimo no puede meter un enlace o texto propio en un correo que ContApp envía a cualquiera", async () => {
    // El estudio y el nombre son texto libre de un anónimo; el destinatario es arbitrario. Si se copian al correo,
    // ContApp firma un mensaje de phishing ("su cuenta vence, pague en https://…").
    const correo = correoNuevo();
    const r = await solicitar(
      cuerpoBase(correo, {
        estudio: "Aviso SUNAT: pague en https://evil-t12a.example/pago hoy",
        nombre: "Ingrese a www.evil-t12a.example ahora",
      }),
    );
    no5xx(r, "solicitud");
    if (r.status === 202) {
      const ms = await h().correo.esperar(correo, 1);
      expect(ms).toHaveLength(1);
      const texto = `${ms[0]!.asunto}\n${ms[0]!.texto}`;
      expect(texto, "el correo reproduce el enlace del atacante").not.toContain("evil-t12a.example");
    }
  });
});

/* ================================ Validación de la entrada ================================ */
describe("T12a · entradas hostiles en estudio, nombre, RUC y correo", () => {
  it("A3 · caracteres de control (C0 y C1) o nombres en blanco: 400 solicitud_invalida, sin pendiente ni correo", async () => {
    const malos: [string, Record<string, unknown>][] = [];
    for (const [etq, c] of [
      ["NUL", "\u0000"],
      ["ESC", "\u001b"],
      ["CR-LF", "\r\n"],
      ["DEL", "\u007f"],
      ["NEL (C1)", "\u0085"],
      ["CSI (C1)", "\u009b"],
    ] as const) {
      malos.push([`estudio con ${etq}`, { estudio: `Estudio${c}Adv` }]);
      malos.push([`nombre con ${etq}`, { nombre: `Nombre${c}Adv` }]);
    }
    malos.push(["estudio solo espacios", { estudio: "     " }]);
    malos.push(["estudio solo NBSP/ideográficos", { estudio: "  　　" }]);
    malos.push(["estudio 1 carácter tras recortar", { estudio: "  a  " }]);
    malos.push(["nombre solo espacios", { nombre: "   " }]);
    const aceptados: string[] = [];
    for (const [etq, o] of malos) {
      const correo = correoNuevo();
      const r = await solicitar(cuerpoBase(correo, o));
      no5xx(r, etq);
      if (r.status !== 400 || r.body?.codigo !== "solicitud_invalida") aceptados.push(`${etq} → ${r.status}`);
      else expect(await pendientes(correo), etq).toHaveLength(0);
    }
    expect(aceptados, "entradas inválidas aceptadas").toEqual([]);
  });

  it("A4 · separadores de línea y controles de dirección (U+2028/2029, RLO, aislantes bidi, ZWJ): rechazados", async () => {
    // No son Cc, pero parten líneas o invierten el texto del correo y de las pantallas (Trojan Source / spoofing).
    const aceptados: string[] = [];
    for (const [etq, c] of [
      ["U+2028", " "],
      ["U+2029", " "],
      ["RLO U+202E", "‮"],
      ["RLI U+2067", "⁧"],
      ["ZWJ U+200D", "‍"],
      ["BOM U+FEFF", "﻿"],
    ] as const) {
      const correo = correoNuevo();
      const r = await solicitar(cuerpoBase(correo, { estudio: `Estudio${c}Adv` }));
      no5xx(r, etq);
      if (r.status !== 400) aceptados.push(`${etq} → ${r.status}`);
    }
    expect(aceptados, "caracteres de formato aceptados en el nombre del estudio").toEqual([]);
  });

  it("A5 · longitudes, tipos y RUC raros: nunca 5xx, y si responde 202 la fila pendiente existe y cumple el contrato", async () => {
    const casos: [string, Record<string, unknown>][] = [
      ["estudio 201", { estudio: "x".repeat(201) }],
      ["estudio 150 emojis", { estudio: "😀".repeat(150) }],
      ["estudio 200 é NFD", { estudio: "é".repeat(200) }],
      ["estudio inyección", { estudio: "Estudio'); drop table tenant; -- %_\\" }],
      ["nombre 10k", { nombre: "n".repeat(10_000) }],
      ["estudio número", { estudio: 12345 }],
      ["estudio objeto", { estudio: { $ne: "" } }],
      ["ruc ancho completo", { ruc: "２０１２３４５６７８９" }],
      ["ruc número", { ruc: 20123456789 }],
      ["ruc 10", { ruc: "2012345678" }],
      ["ruc 12", { ruc: "201234567890" }],
      ["ruc con salto", { ruc: "20123456789\n" }],
      ["ruc con espacio", { ruc: " 20123456789" }],
      ["ruc árabe-índico", { ruc: "٢٠١٢٣٤٥٦٧٨٩" }],
      ["ruc vacío", { ruc: "" }],
      ["ruc null", { ruc: null }],
      ["correo con cabecera", { correo: "x@t006.contapp.test\r\nBcc: v@evil-t12a.example" }],
      ["correo con NUL", { correo: "x\u0000@t006.contapp.test" }],
      ["correo lista", { correo: "a@t006.contapp.test,b@evil-t12a.example" }],
    ];
    const problemas: string[] = [];
    for (const [etq, o] of casos) {
      const correo = correoNuevo();
      const cuerpo = cuerpoBase(correo, o);
      const r = await solicitar(cuerpo);
      if (r.status >= 500) {
        problemas.push(`${etq} → ${r.status}`);
        continue;
      }
      if (typeof cuerpo.correo === "string" && cuerpo.correo !== correo && r.status === 202) {
        // Solo si se aceptó; un NUL en la lista rompería la limpieza del soporte.
        if (!cuerpo.correo.includes("\u0000")) p.rastrearRegistro(cuerpo.correo);
        problemas.push(`${etq} → 202 con correo hostil`);
        continue;
      }
      if (r.status === 202) {
        const f = await pendientes(correo);
        if (f.length !== 1) problemas.push(`${etq} → 202 pero ${f.length} pendientes (fallo silencioso)`);
        else {
          const fila = f[0];
          if (fila.ruc_estudio !== null && !/^[0-9]{11}$/.test(fila.ruc_estudio)) problemas.push(`${etq} → ruc ${fila.ruc_estudio}`);
          if ([...String(fila.nombre_estudio)].length > 200 || [...String(fila.nombre_usuario)].length > 200)
            problemas.push(`${etq} → nombre de más de 200`);
          if (typeof o.estudio !== "string" && "estudio" in o) problemas.push(`${etq} → tipo no cadena aceptado`);
        }
      } else if (r.status !== 400 && r.status !== 413) problemas.push(`${etq} → ${r.status}`);
    }
    expect(problemas).toEqual([]);
  });
});

/* ================================ Asignación masiva ================================ */
describe("T12a · plan, rol, estado o tenant del cuerpo se ignoran al confirmar", () => {
  it("A6 · /registro/confirmar y /confirmar-con-sesion con plan/rol/tenantId extra: Prueba, Dueño solo del estudio nuevo", async () => {
    const { tenantA, uA } = seedAuth();
    const corp = (await p.sql("select id from plan where codigo = 'corporativo'"))[0].id;
    const extra = {
      plan: "corporativo",
      planId: corp,
      codigo: "corporativo",
      estado: "activa",
      rol: "admin",
      rucsExtraContratados: 999,
      pruebaVenceEn: "2099-01-01T00:00:00Z",
      tenantId: tenantA,
      estudioId: tenantA,
      usuarioId: uA,
      constructor: { prototype: { rol: "admin" } },
    };
    // cuenta nueva
    const correo = correoNuevo();
    const token = await registrar(correo);
    const r = await confirmar(token, extra);
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const [uid] = await usuarioPorCorreo(correo);
    expect(uid).toBeDefined();
    expect(uid).not.toBe(uA);
    const es = await estudiosDe(uid!);
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ rol: "dueno", estado: "prueba", codigo: "prueba", rucs_extra_contratados: 0 });
    expect(es[0].tenant_id).not.toBe(tenantA);
    expect(Number(es[0].dias)).toBeLessThan(14.01);
    // cuenta existente
    const u = await cuentaExistente();
    const t2 = await registrar(u.correo);
    const s = await h().entrar(u);
    const r2 = await p.como(s, "POST", "/registro/confirmar-con-sesion", { token: t2, ...extra });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.estudio.id).not.toBe(tenantA);
    const es2 = await estudiosDe(u.id);
    expect(es2).toHaveLength(1);
    expect(es2[0]).toMatchObject({ rol: "dueno", estado: "prueba", codigo: "prueba", rucs_extra_contratados: 0 });
    expect(es2[0].tenant_id).toBe(r2.body.estudio.id);
  });
});

/* ================================ Enlace: reuso, carreras, flujo cruzado ================================ */
describe("T12a · el enlace es de un solo uso entre rutas y concurrencia", () => {
  it("A7 · reuso cruzado: usado en /confirmar no sirve en /confirmar-con-sesion (ni al revés)", async () => {
    // nueva → /confirmar → luego con-sesion con la sesión recién creada
    const correo = correoNuevo();
    const token = await registrar(correo);
    expect((await confirmar(token)).status).toBe(204);
    const [uid] = await usuarioPorCorreo(correo);
    const s = await h().entrar({ correo, contrasena: CONTRASENA });
    const r = await p.como(s, "POST", "/registro/confirmar-con-sesion", { token });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "registro_invalido" });
    expect(await estudiosDe(uid!)).toHaveLength(1);
    // existente → con-sesion → luego /confirmar y /consultar
    const u = await cuentaExistente();
    const t2 = await registrar(u.correo);
    const s2 = await h().entrar(u);
    expect((await p.como(s2, "POST", "/registro/confirmar-con-sesion", { token: t2 })).status).toBe(200);
    const c = await confirmar(t2);
    expect(c.status).toBe(400);
    expect(c.body).toEqual({ codigo: "registro_invalido" });
    expect((await consultar(t2)).status).toBe(400);
    expect(await estudiosDe(u.id)).toHaveLength(1);
  });

  it("A8 · cinco /confirmar-con-sesion simultáneos con el mismo enlace: un solo estudio", async () => {
    const u = await cuentaExistente();
    const token = await registrar(u.correo);
    const s = await h().entrar(u);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => p.como(s, "POST", "/registro/confirmar-con-sesion", { token })),
    );
    for (const r of rs) no5xx(r, "con-sesion");
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await estudiosDe(u.id)).toHaveLength(1);
  });

  it("A9 · solicitudes simultáneas del mismo correo dejan a lo sumo un enlace vivo (y nunca dos estudios)", async () => {
    const correo = correoNuevo();
    const rs = await Promise.all(Array.from({ length: 3 }, () => solicitar(cuerpoBase(correo))));
    for (const r of rs) no5xx(r, "solicitud");
    const ok = rs.filter((r) => r.status === 202).length;
    await h().correo.esperar(correo, ok, 5000);
    const tokens = tokensDe(correo);
    const vivos: string[] = [];
    for (const t of tokens) if ((await consultar(t)).status === 200) vivos.push(t);
    const confirmaciones = await Promise.all(vivos.map((t) => confirmar(t)));
    for (const r of confirmaciones) no5xx(r, "confirmación");
    expect((await usuarioPorCorreo(correo)).length).toBeLessThanOrEqual(1);
    expect(vivos.length, `enlaces vivos a la vez para el mismo correo: ${vivos.length}`).toBeLessThanOrEqual(1);
  });

  it("A10 · si la cuenta nace entre la solicitud y la confirmación: 409 requiere_sesion, la contraseña previa no se toca", async () => {
    const correo = correoNuevo();
    const token = await registrar(correo);
    // La cuenta aparece por otra vía (p. ej. aceptar una invitación de 005) después de pedir el registro.
    const id = randomUUID();
    const previa = `Previa-${randomBytes(6).toString("hex")}-ñ`;
    const phc = await argonHash(previa, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32, algorithm: 2 as never });
    await p.sql("insert into usuario (id, email, nombre) values ($1, $2, 'Cuenta tardía T12a')", [id, correo]);
    await p.sql("insert into auth.usuario_contrasena (usuario_id, hash, actualizada_en) values ($1, $2, now())", [id, phc]);
    const c = await consultar(token);
    expect(c.status).toBe(200);
    expect(c.body.cuentaExiste).toBe(true);
    const r = await confirmar(token);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body).toEqual({ codigo: "requiere_sesion" });
    expect(await usuarioPorCorreo(correo)).toEqual([id]);
    expect(await estudiosDe(id)).toHaveLength(0);
    expect((await h().login(correo, previa)).status).toBe(200);
    expect((await h().login(correo, CONTRASENA)).status).toBe(401);
  });

  it("A11 · tokens de otro flujo no se cruzan: recuperación ↔ registro", async () => {
    const u = await cuentaExistente();
    const tReg = await registrar(u.correo);
    const antes = h().correo.para(u.correo).length;
    const rr = await h().pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo } });
    expect(rr.status).toBe(202);
    await h().correo.esperar(u.correo, antes + 1);
    const tRec = tokensDe(u.correo).at(-1)!;
    expect(tRec).not.toBe(tReg);
    // recuperación → registro
    const s = await h().entrar(u);
    expect((await consultar(tRec)).status).toBe(400);
    expect((await confirmar(tRec)).status).toBe(400);
    expect((await p.como(s, "POST", "/registro/confirmar-con-sesion", { token: tRec })).status).toBe(400);
    expect(await estudiosDe(u.id)).toHaveLength(0);
    // registro → recuperación
    const nueva = "Otra-contrasena-T12a-ñ-77";
    const rest = await h().pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token: tReg, contrasena: nueva } });
    expect(rest.status).toBe(400);
    expect((await h().login(u.correo, nueva)).status).toBe(401);
  });
});

/* ================================ Abuso: límites por IP ================================ */
describe("T12a · el límite por IP no se evade con cabeceras", () => {
  const seisSolicitudes = async (xff: (i: number) => string) => {
    const st: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await solicitar(cuerpoBase(correoNuevo()), { ip: null, cabeceras: { "X-Forwarded-For": xff(i) } });
      st.push(r.status);
    }
    return st;
  };

  it("A12 · X-Forwarded-For con varios saltos: la entrada izquierda (la que escribe el cliente) no define la IP", async () => {
    const fija = ip();
    const st = await seisSolicitudes(() => `${ip()}, ${fija}`);
    expect(st.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(st[5], `estados: ${st.join(",")}`).toBe(429);
  });

  it("A13 · la misma IPv4 escrita como IPv6 mapeada (::ffff:a.b.c.d) cuenta como la misma", async () => {
    const v4 = ip();
    ips.push(`::ffff:${v4}`);
    const st = await seisSolicitudes((i) => (i % 2 === 0 ? v4 : `::ffff:${v4}`));
    expect(st[5], `estados: ${st.join(",")}`).toBe(429);
  });

  it("A14 · X-Forwarded-For basura o enorme: nunca 5xx y el límite sigue aplicando", async () => {
    for (const basura of ["no-es-una-ip-t12a", `t12a-${"a".repeat(300)}`]) {
      ips.push(basura);
      const st = await seisSolicitudes(() => basura);
      for (const s of st) expect(s, `XFF ${basura.slice(0, 20)}…: ${st.join(",")}`).toBeLessThan(500);
      expect(st[5], `XFF ${basura.slice(0, 20)}…: ${st.join(",")}`).toBe(429);
    }
  });
});

/* ================================ Abuso: pruebas en serie ================================ */
describe("T12a · estudios basura con una cuenta existente", () => {
  it("A15 · una cuenta no encadena pruebas gratis: un segundo registro con sesión no crea otra Prueba de 14 días", async () => {
    // Hallazgo de spec (D3 no limita): cada enlace confirmado con sesión crea otro estudio con Prueba nueva; al vencer
    // una prueba, el mismo contador abre otra sin pagar (riesgo (3) de la spec: cobro perdido).
    const u = await cuentaExistente();
    const s = await h().entrar(u);
    for (let i = 0; i < 2; i++) {
      const t = await registrar(u.correo, { estudio: `${ESTUDIO} serie ${i}` });
      no5xx(await p.como(s, "POST", "/registro/confirmar-con-sesion", { token: t }), "con-sesion");
    }
    const pruebas = (await estudiosDe(u.id)).filter((e) => e.rol === "dueno" && e.estado === "prueba");
    expect(pruebas.length, "estudios en Prueba de la misma cuenta").toBeLessThanOrEqual(1);
  });
});

/* ================================ Secretos fuera de logs y de Redis ================================ */
describe("T12a · el token no queda en claro fuera del correo", () => {
  it("A16 · con el envío del correo fallando, ni el token ni el texto del mensaje llegan a los logs", async () => {
    const correo = correoNuevo();
    let token = "";
    const correoApp = h().correo;
    correoApp.alEnviar = async (m) => {
      const t = /#t=([A-Za-z0-9_-]+)/.exec(m.texto)?.[1];
      if (t && m.para.trim().toLowerCase() === correo) token = t;
    };
    correoApp.fallar = new Error("smtp caído (canario T12a)");
    try {
      const { logs, resultado } = await capturarLogs(async () => {
        const r = await solicitar(cuerpoBase(correo));
        const fin = Date.now() + 5000;
        while (!token && Date.now() < fin) await new Promise((res) => setTimeout(res, 25));
        await new Promise((res) => setTimeout(res, 1500)); // reintentos y registro del error de la cola
        return r;
      });
      expect(resultado.status).toBe(202);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(logs).not.toContain(token);
      expect(logs).not.toContain("/registro/confirmar#t=");
    } finally {
      correoApp.fallar = null;
      correoApp.alEnviar = null;
    }
  });

  it("A17 · el token no queda en claro en Redis (trabajos de la cola de correo)", async () => {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("falta REDIS_URL");
    const correo = correoNuevo();
    const token = await registrar(correo);
    await new Promise((res) => setTimeout(res, 500));
    const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await r.connect();
    const hallados: string[] = [];
    try {
      let cursor = "0";
      do {
        const [sig, claves] = await r.scan(cursor, "COUNT", 500);
        cursor = sig;
        for (const k of claves.map(String)) {
          const tipo = await r.type(k);
          let valor = "";
          if (tipo === "string") valor = (await r.get(k)) ?? "";
          else if (tipo === "hash") valor = JSON.stringify(await r.hgetall(k));
          else if (tipo === "list") valor = JSON.stringify(await r.lrange(k, 0, -1));
          else if (tipo === "set") valor = JSON.stringify(await r.smembers(k));
          else if (tipo === "zset") valor = JSON.stringify(await r.zrange(k, "0", "-1"));
          else if (tipo === "stream") valor = JSON.stringify(await r.call("XRANGE", k, "-", "+"));
          if (k.includes(token) || valor.includes(token)) hallados.push(k);
        }
      } while (cursor !== "0");
    } finally {
      r.disconnect();
    }
    expect(hallados, "claves de Redis con el token en claro").toEqual([]);
  });
});
