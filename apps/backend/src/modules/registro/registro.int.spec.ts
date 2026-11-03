/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// T3 (006) · CA-3 (registro, RF-002/HU-01, D3) y CA-4 (sin oráculo, token solo como hash, límites). Correo en memoria
// por la cola, Argon2 real en el piso. Los canarios (token, contraseña) no deben aparecer en logs, errores ni respuestas.
// Rojo: las rutas /registro/*, `registro_pendiente` y las funciones `auth.registro_*` aún no existen (T5, T8).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  capturarLogs,
  esHashDe,
  forma,
  hashViejo,
  ipUnica,
  mediana,
  ORIGEN,
  PWD,
  type Resp,
} from "../../../test/soporte.js";
import { abrirBancoPlanes, type BancoPlanes } from "../../../test/soporte-planes.js";

const CONTRASENA = "Canario-contrasena-006-ñ-Zq";
const ESTUDIO = "Estudio Registro T3";
const NOMBRE = "Dueña Registro T3";
let p: BancoPlanes;
const h = () => p.b.h;

beforeAll(async () => {
  p = await abrirBancoPlanes();
  await limpiarLimites();
});
afterAll(async () => {
  await limpiarLimites().catch(() => undefined);
  await p?.cerrar();
});
// Ajuste de 006 (T13a): D15 agrega el tipo `registro_confirmar_ip` (10 por hora por IP) al limite de /registro/confirmar.
const limpiarLimites = () =>
  p.sql("delete from auth.limite_tasa where tipo in ('registro_ip', 'registro_correo', 'registro_confirmar_ip')");

/* ---------------------------------- utilidades ---------------------------------- */
const solicitar = (o: { correo: string; estudio?: string; ruc?: string | null; nombre?: string }, extra = {}) =>
  h().pedir({
    ruta: "/registro",
    cuerpo: {
      estudio: o.estudio ?? ESTUDIO,
      nombre: o.nombre ?? NOMBRE,
      correo: o.correo,
      ...(o.ruc === undefined || o.ruc === null ? {} : { ruc: o.ruc }),
    },
    ...extra,
  });
const consultar = (token: string) => h().pedir({ ruta: "/registro/consultar", cuerpo: { token } });
const confirmar = (token: string, contrasena = CONTRASENA) =>
  h().pedir({ ruta: "/registro/confirmar", cuerpo: { token, contrasena } });
const pendientes = (correo: string) =>
  p.sql("select * from auth.registro_pendiente where correo = $1 order by creada_en desc, id", [correo]);

/** Pide el registro de un correo nuevo y devuelve el token del enlace del correo. */
async function registrar(o: { estudio?: string; ruc?: string | null; correo?: string } = {}) {
  const correo = o.correo ?? p.correoRegistro();
  const antes = h().correo.para(correo).length;
  const r = await solicitar({ correo, estudio: o.estudio, ruc: o.ruc });
  expect(r.status).toBe(202);
  await h().correo.esperar(correo, antes + 1);
  return { correo, token: h().correo.tokenDe(correo), r };
}
const tenantDe = async (correo: string): Promise<string | undefined> =>
  (await p.sql("select m.tenant_id from membresia m join usuario u on u.id = m.usuario_id where u.email = $1", [correo]))[0]
    ?.tenant_id;
const estudiosPorNombre = (nombre: string) => p.sql("select id from tenant where nombre = $1", [nombre]);
/** Cuenta existente (sin estudios) con contraseña conocida; anota el correo para limpiar sus pendientes. */
async function cuentaExistente(hash?: string) {
  const u = await h().crearUsuario({ estudios: [], hash });
  p.rastrearRegistro(u.correo);
  return u;
}
const alterar = (t: string) => `${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`;

/* ---------------------------------- CA-4 · solicitar ---------------------------------- */
describe("CA-4 · POST /registro responde igual exista o no la cuenta", () => {
  it("202 { ok: true } con el mismo cuerpo, código y cabeceras, sin Set-Cookie y con no-store", async () => {
    const u = await cuentaExistente();
    const nueva = await solicitar({ correo: p.correoRegistro() });
    const existe = await solicitar({ correo: u.correo });
    expect(nueva.status).toBe(202);
    expect(nueva.body).toEqual({ ok: true });
    expect(forma(existe)).toEqual(forma(nueva));
    expect(nueva.setCookies).toEqual([]);
    expect(existe.setCookies).toEqual([]);
    expect(nueva.headers["cache-control"]).toMatch(/no-store/);
  });

  it("escribe lo mismo en ambos casos: una fila pendiente por correo y un correo con el enlace #t= (mismo texto)", async () => {
    const u = await cuentaExistente();
    const nuevo = p.correoRegistro();
    await solicitar({ correo: nuevo, ruc: "20123456789" });
    await solicitar({ correo: u.correo, ruc: "20123456789" });
    for (const c of [nuevo, u.correo]) {
      expect(await pendientes(c)).toHaveLength(1);
      expect(await h().correo.esperar(c, 1)).toHaveLength(1);
    }
    const [m1] = h().correo.para(nuevo);
    const [m2] = h().correo.para(u.correo);
    const t1 = h().correo.tokenDe(nuevo);
    const t2 = h().correo.tokenDe(u.correo);
    expect(m1!.texto).toContain(`${ORIGEN}/registro/confirmar#t=${t1}`);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t2).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t1).not.toBe(t2);
    const neutro = (m: typeof m1, correo: string, tok: string) =>
      JSON.stringify({ asunto: (m as any).asunto, texto: m!.texto }).replaceAll(tok, "<t>").replaceAll(correo, "<c>");
    expect(neutro(m1, nuevo, t1)).toBe(neutro(m2, u.correo, t2));
    const f1 = (await pendientes(nuevo))[0];
    const f2 = (await pendientes(u.correo))[0];
    expect(Object.keys(f1).sort()).toEqual(Object.keys(f2).sort());
    expect(f1.consumida_en).toBeNull();
    expect(f2.consumida_en).toBeNull();
  });

  it("el token se guarda solo como hash SHA-256 (32 B), vence a las 24 h y no viaja en la respuesta", async () => {
    const { correo, token, r } = await registrar();
    const f = (await pendientes(correo))[0];
    expect(Buffer.isBuffer(f.token_hash)).toBe(true);
    expect(f.token_hash).toHaveLength(32);
    expect(esHashDe(f.token_hash, token)).toBe(true);
    expect(JSON.stringify(f)).not.toContain(token);
    expect(r.text).not.toContain(token);
    expect(JSON.stringify(r.headers)).not.toContain(token);
    const horas = Number(
      (await p.sql("select extract(epoch from (vence_en - creada_en)) / 3600 as h from auth.registro_pendiente where id = $1", [f.id]))[0].h,
    );
    expect(horas).toBeCloseTo(24, 1);
    expect(f).toMatchObject({ nombre_estudio: ESTUDIO, nombre_usuario: NOMBRE, ruc_estudio: null });
  });

  it("normaliza el correo (D13 de 004), guarda el RUC del estudio (11 dígitos) y nada se crea hasta confirmar", async () => {
    const base = p.correoRegistro();
    const estudio = `Estudio sin crear ${randomBytes(3).toString("hex")}`;
    const r = await solicitar({ correo: `  ${base.toUpperCase()} `, ruc: "20123456789", estudio });
    expect(r.status).toBe(202);
    const f = (await pendientes(base))[0];
    expect(f).toMatchObject({ correo: base, ruc_estudio: "20123456789" });
    expect(await estudiosPorNombre(estudio)).toHaveLength(0);
    expect(await p.sql("select 1 from usuario where email = $1", [base])).toHaveLength(0);
  });

  it("el correo sale por la cola, fuera de la petición: con el envío retenido la respuesta no espera", async () => {
    const correo = p.correoRegistro();
    h().correo.retenido = true;
    try {
      const t0 = Date.now();
      const r = await solicitar({ correo });
      expect(r.status).toBe(202);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(h().correo.para(correo)).toHaveLength(0);
    } finally {
      h().correo.liberar();
    }
    expect(await h().correo.esperar(correo, 1)).toHaveLength(1);
  });

  it("si el envío falla, la respuesta sigue siendo 202 igual (no revela nada por el error del correo)", async () => {
    const correo = p.correoRegistro();
    h().correo.fallar = new Error("SMTP caído canario-006");
    try {
      const { resultado, logs } = await capturarLogs(() => solicitar({ correo }));
      expect(resultado.status).toBe(202);
      expect(resultado.body).toEqual({ ok: true });
      expect(resultado.text).not.toContain("canario-006");
      void logs;
    } finally {
      h().correo.fallar = null;
    }
  });

  it("solicitar de nuevo invalida el enlace anterior del mismo correo y deja una sola fila viva", async () => {
    const a = await registrar();
    const antes = h().correo.para(a.correo).length;
    expect((await solicitar({ correo: a.correo })).status).toBe(202);
    await h().correo.esperar(a.correo, antes + 1);
    const nuevo = h().correo.tokenDe(a.correo);
    expect(nuevo).not.toBe(a.token);
    expect((await consultar(a.token)).status).toBe(400);
    expect((await confirmar(a.token)).status).toBe(400);
    expect((await consultar(nuevo)).status).toBe(200);
    const vivas = (await pendientes(a.correo)).filter((f: any) => f.consumida_en === null && new Date(f.vence_en) > new Date());
    expect(vivas.length).toBeLessThanOrEqual(1);
  });

  it("registro_crear borra los pendientes vencidos hace más de 7 días al registrar otro", async () => {
    const viejo = await registrar();
    await p.sql("update auth.registro_pendiente set creada_en = now() - interval '9 days', vence_en = now() - interval '8 days' where correo = $1", [
      viejo.correo,
    ]);
    await registrar();
    expect(await pendientes(viejo.correo)).toHaveLength(0);
  });

  it("origen ajeno: 403 origen_invalido y no se crea nada", async () => {
    const correo = p.correoRegistro();
    const r = await solicitar({ correo }, { origen: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "origen_invalido" });
    expect(await pendientes(correo)).toHaveLength(0);
    expect(h().correo.para(correo)).toHaveLength(0);
  });

  it("umbral de tiempos: |mediana(cuenta existente) - mediana(cuenta nueva)| <= max(5 ms, 10 %)", async () => {
    const N = 30;
    const rapido = await hashViejo(PWD);
    const existentes = await Promise.all(Array.from({ length: N }, () => cuentaExistente(rapido)));
    const t = { nueva: [] as number[], existe: [] as number[] };
    for (let i = 0; i < 6; i++) {
      await solicitar({ correo: p.correoRegistro() });
      await solicitar({ correo: existentes[i]!.correo });
    }
    for (let i = 6; i < N; i++) {
      const orden = i % 2 === 0;
      for (const rama of orden ? (["nueva", "existe"] as const) : (["existe", "nueva"] as const)) {
        const r = await solicitar({ correo: rama === "nueva" ? p.correoRegistro() : existentes[i]!.correo });
        expect(r.status).toBe(202);
        t[rama].push(r.ms);
      }
    }
    const base = mediana(t.nueva);
    expect(Math.abs(mediana(t.existe) - base)).toBeLessThanOrEqual(Math.max(5, base * 0.1));
  }, 120_000);
});

describe("CA-4 · validación de la solicitud (400 solicitud_invalida, sin eco de la entrada)", () => {
  const CANARIO = "canario-eco-006";
  it.each([
    ["estudio vacío", { estudio: "", nombre: NOMBRE, correo: "ok@t006.contapp.test" }],
    ["estudio de 201 caracteres", { estudio: "e".repeat(201), nombre: NOMBRE, correo: "ok@t006.contapp.test" }],
    ["estudio con caracteres de control", { estudio: `a\u0000b ${CANARIO}`, nombre: NOMBRE, correo: "ok@t006.contapp.test" }],
    ["nombre vacío", { estudio: ESTUDIO, nombre: "", correo: "ok@t006.contapp.test" }],
    ["nombre de 201 caracteres", { estudio: ESTUDIO, nombre: "n".repeat(201), correo: "ok@t006.contapp.test" }],
    ["correo sin arroba", { estudio: ESTUDIO, nombre: NOMBRE, correo: `sin-arroba-${CANARIO}` }],
    ["correo de 321 caracteres", { estudio: ESTUDIO, nombre: NOMBRE, correo: `${"a".repeat(310)}@t006.test` }],
    ["RUC de 10 dígitos", { estudio: ESTUDIO, nombre: NOMBRE, correo: "ok@t006.contapp.test", ruc: "2012345678" }],
    ["RUC de 12 dígitos", { estudio: ESTUDIO, nombre: NOMBRE, correo: "ok@t006.contapp.test", ruc: "201234567890" }],
    ["RUC con letras", { estudio: ESTUDIO, nombre: NOMBRE, correo: "ok@t006.contapp.test", ruc: `2012345678${CANARIO}` }],
    ["RUC numérico (no cadena)", { estudio: ESTUDIO, nombre: NOMBRE, correo: "ok@t006.contapp.test", ruc: 20123456789 }],
    ["faltan campos", { correo: "ok@t006.contapp.test" }],
    ["cuerpo vacío", {}],
    ["campos con tipos incorrectos", { estudio: [ESTUDIO], nombre: { a: 1 }, correo: 5 }],
  ])("%s -> 400 { codigo: solicitud_invalida } y no se crea pendiente ni correo", async (_n, cuerpo) => {
    const antes = Number((await p.sql("select count(*)::int n from auth.registro_pendiente"))[0].n);
    const r = await h().pedir({ ruta: "/registro", cuerpo });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(r.text).not.toContain(CANARIO);
    expect(r.setCookies).toEqual([]);
    expect(Number((await p.sql("select count(*)::int n from auth.registro_pendiente"))[0].n)).toBe(antes);
  });

  it("JSON roto o cuerpo enorme: 400/413 sin eco ni pendiente", async () => {
    const roto = await h().pedir({ ruta: "/registro", crudo: `{"estudio": "${CANARIO}` });
    expect(roto.status).toBe(400);
    expect(roto.text).not.toContain(CANARIO);
    const enorme = await h().pedir({ ruta: "/registro", crudo: JSON.stringify({ estudio: "x".repeat(20_000), nombre: "n", correo: "a@b.co" }) });
    expect(enorme.status).toBe(413);
  });

  it("claves desconocidas del cuerpo se descartan: un `tenantId`/`planId` en la solicitud no cambia el plan ni el estudio", async () => {
    const correo = p.correoRegistro();
    const plan = await p.plan({ maxRucs: 500 });
    const r = await h().pedir({
      ruta: "/registro",
      cuerpo: { estudio: ESTUDIO, nombre: NOMBRE, correo, planId: plan.id, plan: "corporativo", tenantId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(r.status).toBe(202);
    const f = (await pendientes(correo))[0];
    expect(JSON.stringify(f)).not.toContain(plan.id);
  });
});

describe("CA-4 · límites por IP y por correo (429)", () => {
  it("5 solicitudes por IP y hora: la 6.ª da 429 demasiados_intentos y no crea pendiente ni correo", async () => {
    const ip = ipUnica();
    for (let i = 0; i < 5; i++) expect((await solicitar({ correo: p.correoRegistro() }, { ip })).status).toBe(202);
    const correo = p.correoRegistro();
    const r = await solicitar({ correo }, { ip });
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ codigo: "demasiados_intentos" });
    expect(r.setCookies).toEqual([]);
    expect(await pendientes(correo)).toHaveLength(0);
    expect(h().correo.para(correo)).toHaveLength(0);
    // otra IP no está afectada
    expect((await solicitar({ correo: p.correoRegistro() })).status).toBe(202);
  });

  it("3 solicitudes por correo y hora: la 4.ª da 429, igual exista o no la cuenta", async () => {
    const u = await cuentaExistente();
    const respuestas: Resp[] = [];
    for (const correo of [p.correoRegistro(), u.correo]) {
      for (let i = 0; i < 3; i++) expect((await solicitar({ correo })).status).toBe(202);
      const r = await solicitar({ correo });
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ codigo: "demasiados_intentos" });
      respuestas.push(r);
    }
    expect(forma(respuestas[1]!)).toEqual(forma(respuestas[0]!));
  });

  it("el correo se cuenta normalizado: mayúsculas y espacios no evaden el límite", async () => {
    const base = p.correoRegistro();
    for (const v of [base, base.toUpperCase(), ` ${base} `]) expect((await solicitar({ correo: v })).status).toBe(202);
    expect((await solicitar({ correo: base })).status).toBe(429);
  });
});

/* ---------------------------------- consultar ---------------------------------- */
describe("POST /registro/consultar", () => {
  it("enlace vivo: 200 con estudio, correo y cuentaExiste=false, sin consumirlo", async () => {
    const { correo, token } = await registrar();
    for (let i = 0; i < 2; i++) {
      const r = await consultar(token);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ estudio: { nombre: ESTUDIO }, correo, cuentaExiste: false });
      expect(r.headers["cache-control"]).toMatch(/no-store/);
      expect(r.setCookies).toEqual([]);
    }
    expect((await pendientes(correo))[0].consumida_en).toBeNull();
  });

  it("con cuenta existente informa cuentaExiste=true (para pedir iniciar sesión, D3)", async () => {
    const u = await cuentaExistente();
    const { token } = await registrar({ correo: u.correo });
    const r = await consultar(token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ correo: u.correo, cuentaExiste: true });
  });

  it("enlace alterado, truncado, aleatorio, vencido, invalidado o ajeno: siempre la misma respuesta 400 registro_invalido", async () => {
    const a = await registrar();
    const b = await registrar();
    const vencido = await registrar();
    await p.sql("update auth.registro_pendiente set vence_en = now() - interval '1 minute' where correo = $1", [vencido.correo]);
    const invalidado = await registrar();
    await solicitar({ correo: invalidado.correo });
    const hashHexDeB = (await pendientes(b.correo))[0].token_hash.toString("hex");
    const hashB64DeB = (await pendientes(b.correo))[0].token_hash.toString("base64url");
    const variantes: [string, string][] = [
      ["aleatorio", randomBytes(32).toString("base64url")],
      ["alterado", alterar(a.token)],
      ["truncado", a.token.slice(0, 20)],
      ["con sufijo", `${a.token}x`],
      ["vencido", vencido.token],
      ["invalidado por una solicitud nueva", invalidado.token],
      ["el hash en hex de otro enlace", hashHexDeB],
      ["el hash en base64url de otro enlace", hashB64DeB],
      ["vacío", ""],
      ["basura", "no-es-un-token"],
    ];
    const referencia = await consultar(randomBytes(32).toString("base64url"));
    expect(referencia.status).toBe(400);
    expect(referencia.body).toEqual({ codigo: "registro_invalido" });
    for (const [nombre, t] of variantes) {
      const r = await consultar(t);
      expect(forma(r), nombre).toEqual(forma(referencia));
    }
    expect((await consultar(a.token)).status).toBe(200); // el original sigue intacto
  });

  it("cuerpo sin token o con tipo incorrecto: 400 sin eco", async () => {
    for (const cuerpo of [{}, { token: 5 }, { token: null }, { token: ["a"] }]) {
      const r = await h().pedir({ ruta: "/registro/consultar", cuerpo });
      expect(r.status).toBe(400);
      expect(["registro_invalido", "solicitud_invalida"]).toContain(r.body.codigo);
    }
  });
});

/* ---------------------------------- confirmar ---------------------------------- */
describe("CA-3 · POST /registro/confirmar (cuenta nueva)", () => {
  it("crea estudio, usuario, membresía Dueño y suscripción Prueba de 14 días con 5 RUCs, en una transacción", async () => {
    const estudio = `Estudio feliz ${randomBytes(3).toString("hex")}`;
    const { correo, token } = await registrar({ estudio, ruc: "20123456789" });
    const r = await confirmar(token);
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect(r.setCookies).toEqual([]); // sin auto-login
    expect(r.headers["cache-control"]).toMatch(/no-store/);

    const tenants = await estudiosPorNombre(estudio);
    expect(tenants).toHaveLength(1);
    const t = tenants[0].id;
    expect((await p.sql("select ruc_estudio from tenant where id = $1", [t]))[0].ruc_estudio).toBe("20123456789");
    const u = (await p.sql("select id, nombre from usuario where email = $1", [correo]))[0];
    expect(u.nombre).toBe(NOMBRE);
    const m = await p.sql("select rol, desactivada_en from membresia where tenant_id = $1", [t]);
    expect(m).toEqual([{ rol: "dueno", desactivada_en: null }]);
    const s = (
      await p.sql(
        `select s.estado, s.rucs_extra_contratados, p.codigo, p.max_rucs,
                extract(epoch from (s.prueba_vence_en - now())) / 86400 as dias
           from suscripcion s join plan p on p.id = s.plan_id where s.tenant_id = $1`,
        [t],
      )
    )[0];
    expect(s).toMatchObject({ estado: "prueba", rucs_extra_contratados: 0, codigo: "prueba", max_rucs: 5 });
    expect(Number(s.dias)).toBeGreaterThan(13.9);
    expect(Number(s.dias)).toBeLessThanOrEqual(14.01);
    expect((await pendientes(correo))[0].consumida_en).not.toBeNull();
    const cred = (await p.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0];
    expect(cred.hash).toMatch(/^\$argon2id\$/);
    expect(cred.hash).not.toContain(CONTRASENA);
  });

  it("después puede iniciar sesión con esa contraseña, es Dueño del estudio y GET /plan/uso muestra Prueba (5 RUCs, 1 usuario)", async () => {
    const { correo, token } = await registrar();
    expect((await confirmar(token)).status).toBe(204);
    const tenantId = (await tenantDe(correo)) as string;
    const id = (await p.sql("select id from usuario where email = $1", [correo]))[0].id;
    const s = await p.b.sesion({ id, correo, contrasena: CONTRASENA }, tenantId);
    const yo = await p.b.llamar({ ...s, tenantId }, "GET", "/acceso/yo");
    expect(yo.status).toBe(200);
    expect(JSON.stringify(yo.body)).toContain("dueno");
    const uso = await p.b.llamar({ ...s, tenantId }, "GET", "/plan/uso");
    expect(uso.status).toBe(200);
    expect(uso.body).toMatchObject({
      plan: { codigo: "prueba" },
      estado: "prueba",
      rucs: { usados: 0, limite: 5, libres: 5 },
      usuarios: { usados: 1, limite: 1 },
    });
  });

  it("contraseña inválida (corta o común): 400 contrasena_invalida ANTES de tocar el token, sin calcular hash; el enlace sigue sirviendo", async () => {
    const { correo, token } = await registrar();
    const calculos = h().hasher.calculos;
    const corta = await confirmar(token, "Corta-123");
    expect(corta.status).toBe(400);
    expect(corta.body).toEqual({ codigo: "contrasena_invalida", motivo: "longitud" });
    const comun = await confirmar(token, "qwertyuiop12");
    expect(comun.status).toBe(400);
    expect(comun.body).toEqual({ codigo: "contrasena_invalida", motivo: "comun" });
    expect(h().hasher.calculos).toBe(calculos);
    expect((await pendientes(correo))[0].consumida_en).toBeNull();
    expect(await tenantDe(correo)).toBeUndefined();
    expect((await confirmar(token)).status).toBe(204);
  });

  it("contraseña inválida con enlace falso: también contrasena_invalida (la validez del enlace no se revela sin una contraseña buena)", async () => {
    const r = await confirmar(randomBytes(32).toString("base64url"), "Corta-123");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "contrasena_invalida", motivo: "longitud" });
  });

  it("enlace reusado, vencido, alterado, invalidado o ajeno: siempre la misma respuesta 400 registro_invalido y no se crea nada", async () => {
    const usado = await registrar();
    expect((await confirmar(usado.token)).status).toBe(204);
    const ajeno = await registrar();
    const vencido = await registrar();
    await p.sql("update auth.registro_pendiente set vence_en = now() - interval '1 minute' where correo = $1", [vencido.correo]);
    const invalidado = await registrar();
    await solicitar({ correo: invalidado.correo });
    const vivo = await registrar();
    const estudiosAntes = Number((await p.sql("select count(*)::int n from tenant"))[0].n);

    const referencia = await confirmar(randomBytes(32).toString("base64url"));
    expect(referencia.status).toBe(400);
    expect(referencia.body).toEqual({ codigo: "registro_invalido" });
    const variantes: [string, string][] = [
      ["reusado", usado.token],
      ["vencido", vencido.token],
      ["invalidado", invalidado.token],
      ["alterado", alterar(vivo.token)],
      ["hash de otro enlace", (await pendientes(ajeno.correo))[0].token_hash.toString("hex")],
      ["vacío", ""],
    ];
    for (const [nombre, t] of variantes) {
      const r = await confirmar(t);
      expect(forma(r), nombre).toEqual(forma(referencia));
      expect(r.setCookies).toEqual([]);
    }
    expect(Number((await p.sql("select count(*)::int n from tenant"))[0].n)).toBe(estudiosAntes);
    expect((await confirmar(vivo.token)).status).toBe(204); // el legítimo sigue valiendo
  });

  it("confirmar cinco veces a la vez crea un solo estudio, un solo usuario y una sola suscripción", async () => {
    const estudio = `Estudio carrera ${randomBytes(3).toString("hex")}`;
    const { correo, token } = await registrar({ estudio });
    const rs = await Promise.all(Array.from({ length: 5 }, () => confirmar(token)));
    expect(rs.filter((r) => r.status === 204)).toHaveLength(1);
    const otros = rs.filter((r) => r.status !== 204);
    expect(otros).toHaveLength(4);
    for (const r of otros) expect(r.body).toEqual({ codigo: "registro_invalido" });
    const tenants = await estudiosPorNombre(estudio);
    expect(tenants).toHaveLength(1);
    expect(await p.sql("select 1 from usuario where email = $1", [correo])).toHaveLength(1);
    expect(await p.sql("select 1 from suscripcion where tenant_id = $1", [tenants[0].id])).toHaveLength(1);
    expect(await p.sql("select 1 from membresia where tenant_id = $1", [tenants[0].id])).toHaveLength(1);
  });

  it("sin plan Prueba activo: 503 registro_no_disponible, nada se crea ni se consume; al reactivar el plan el mismo enlace funciona", async () => {
    const { correo, token } = await registrar();
    await p.sql("update plan set activo = false where codigo = 'prueba'");
    try {
      const r = await confirmar(token);
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ codigo: "registro_no_disponible" });
      expect(await tenantDe(correo)).toBeUndefined();
      expect((await pendientes(correo))[0].consumida_en).toBeNull();
    } finally {
      await p.sql("update plan set activo = true where codigo = 'prueba'");
    }
    expect((await confirmar(token)).status).toBe(204);
  });

  it("el plan de la suscripción sale de la BD (CA-2): si Prueba cambia de límites, el estudio nuevo hereda el plan editado", async () => {
    const orig = (await p.sql("select max_rucs from plan where codigo = 'prueba'"))[0].max_rucs;
    await p.sql("update plan set max_rucs = 7 where codigo = 'prueba'");
    try {
      const { correo, token } = await registrar();
      expect((await confirmar(token)).status).toBe(204);
      const tenantId = (await tenantDe(correo)) as string;
      const id = (await p.sql("select id from usuario where email = $1", [correo])).at(0)!.id;
      const s = await p.b.sesion({ id, correo, contrasena: CONTRASENA }, tenantId);
      const uso = await p.b.llamar({ ...s, tenantId }, "GET", "/plan/uso");
      expect(uso.body.rucs.limite).toBe(7);
    } finally {
      await p.sql("update plan set max_rucs = $1 where codigo = 'prueba'", [orig]);
    }
  });

  it("origen ajeno: 403 origen_invalido y el enlace no se consume", async () => {
    const { correo, token } = await registrar();
    const r = await h().pedir({ ruta: "/registro/confirmar", cuerpo: { token, contrasena: CONTRASENA }, origen: "https://evil.example" });
    expect(r.status).toBe(403);
    expect((await pendientes(correo))[0].consumida_en).toBeNull();
  });
});

describe("CA-3 · cuenta existente: requiere sesión (D3, como D15 de 005)", () => {
  it("POST /registro/confirmar con un correo que ya tiene cuenta: 409 requiere_sesion, no consume, no crea nada y no toca la contraseña", async () => {
    const u = await cuentaExistente();
    const { correo, token } = await registrar({ correo: u.correo, estudio: `Estudio ajeno ${randomBytes(3).toString("hex")}` });
    const hashAntes = (await p.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0].hash;
    const antes = Number((await p.sql("select count(*)::int n from tenant"))[0].n);
    const r = await confirmar(token, "Otra-contrasena-006-ñ-Qz");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "requiere_sesion" });
    expect(r.setCookies).toEqual([]);
    expect((await pendientes(correo))[0].consumida_en).toBeNull();
    expect(Number((await p.sql("select count(*)::int n from tenant"))[0].n)).toBe(antes);
    expect((await p.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0].hash).toBe(hashAntes);
    expect((await h().login(u.correo, u.contrasena)).status).toBe(200); // la contraseña vieja sigue valiendo
  });

  it("POST /registro/confirmar-con-sesion con el mismo correo: 200 {estudio:{id,nombre}}, Dueño y Prueba de 14 días, contraseña intacta", async () => {
    const u = await cuentaExistente();
    const estudio = `Estudio con sesion ${randomBytes(3).toString("hex")}`;
    const { token } = await registrar({ correo: u.correo, estudio });
    const hashAntes = (await p.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0].hash;
    const s = await h().entrar(u);
    const r = await p.como(s, "POST", "/registro/confirmar-con-sesion", { token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estudio: { id: expect.any(String), nombre: estudio } });
    const t = r.body.estudio.id;
    expect(await p.sql("select rol from membresia where tenant_id = $1 and usuario_id = $2", [t, u.id])).toEqual([{ rol: "dueno" }]);
    const sus = (
      await p.sql(
        "select s.estado, p.codigo, extract(epoch from (s.prueba_vence_en - now())) / 86400 as dias from suscripcion s join plan p on p.id = s.plan_id where s.tenant_id = $1",
        [t],
      )
    )[0];
    expect(sus).toMatchObject({ estado: "prueba", codigo: "prueba" });
    expect(Number(sus.dias)).toBeGreaterThan(13.9);
    expect((await p.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id]))[0].hash).toBe(hashAntes);
    // el enlace ya se usó
    const otra = await p.como(s, "POST", "/registro/confirmar-con-sesion", { token });
    expect(otra.status).toBe(400);
    expect(otra.body).toEqual({ codigo: "registro_invalido" });
  });

  it("confirmar-con-sesion con la sesión de OTRO correo: 400 registro_invalido, sin estudio nuevo y el enlace sigue vivo", async () => {
    const dueño = await cuentaExistente();
    const intruso = await cuentaExistente();
    const estudio = `Estudio intruso ${randomBytes(3).toString("hex")}`;
    const { token } = await registrar({ correo: dueño.correo, estudio });
    const s = await h().entrar(intruso);
    const r = await p.como(s, "POST", "/registro/confirmar-con-sesion", { token });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "registro_invalido" });
    expect(await estudiosPorNombre(estudio)).toHaveLength(0);
    expect(await p.sql("select 1 from membresia where usuario_id = $1", [intruso.id])).toHaveLength(0);
    const ok = await p.como(await h().entrar(dueño), "POST", "/registro/confirmar-con-sesion", { token });
    expect(ok.status).toBe(200);
  });

  it("confirmar-con-sesion con un enlace de correo SIN cuenta (o falso): 400 registro_invalido y no crea nada", async () => {
    const u = await cuentaExistente();
    const s = await h().entrar(u);
    const estudio = `Estudio sin cuenta ${randomBytes(3).toString("hex")}`;
    const nuevo = await registrar({ estudio });
    for (const token of [nuevo.token, randomBytes(32).toString("base64url"), ""]) {
      const r = await p.como(s, "POST", "/registro/confirmar-con-sesion", { token });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ codigo: "registro_invalido" });
    }
    expect(await estudiosPorNombre(estudio)).toHaveLength(0);
  });

  it("confirmar-con-sesion sin sesión: 401; sin CSRF: 403; con origen ajeno: 403", async () => {
    const u = await cuentaExistente();
    const { token } = await registrar({ correo: u.correo });
    const sinSesion = await h().pedir({ ruta: "/registro/confirmar-con-sesion", cuerpo: { token } });
    expect(sinSesion.status).toBe(401);
    const s = await h().entrar(u);
    const sinCsrf = await h().pedir({ ruta: "/registro/confirmar-con-sesion", cuerpo: { token }, cookie: s.cookie });
    expect(sinCsrf.status).toBe(403);
    const origen = await p.como(s, "POST", "/registro/confirmar-con-sesion", { token }, { origen: "https://evil.example" });
    expect(origen.status).toBe(403);
    expect((await pendientes(u.correo))[0].consumida_en).toBeNull();
  });
});

/* ---------------------------------- canarios ---------------------------------- */
describe("CA-4 · el token y la contraseña no aparecen en logs, errores ni respuestas", () => {
  it("flujo completo y fallos (400, 409, 429, 503) con logs capturados: ni el token ni la contraseña salen", async () => {
    const u = await cuentaExistente();
    const respuestas: Resp[] = [];
    const { resultado: token, logs } = await capturarLogs(async () => {
      const a = await registrar();
      respuestas.push(a.r);
      respuestas.push(await confirmar(a.token, "Corta-123")); // contraseña inválida
      respuestas.push(await consultar(alterar(a.token))); // enlace alterado
      respuestas.push(await confirmar(alterar(a.token))); // enlace alterado
      respuestas.push(await consultar(a.token));
      respuestas.push(await confirmar(a.token)); // feliz (204)
      respuestas.push(await confirmar(a.token)); // reusado
      const b = await registrar({ correo: u.correo });
      respuestas.push(await confirmar(b.token)); // 409 requiere_sesion
      const ip = ipUnica();
      for (let i = 0; i < 6; i++) respuestas.push(await solicitar({ correo: p.correoRegistro() }, { ip })); // 429
      return { a: a.token, b: b.token };
    });
    const secretos = [token.a, token.b, CONTRASENA, "Corta-123"];
    const todo = `${logs}\n${respuestas.map((r) => `${r.text}\n${JSON.stringify(r.headers)}\n${r.setCookies.join(";")}`).join("\n")}`;
    for (const s of secretos) expect(todo, `aparece ${s.slice(0, 6)}…`).not.toContain(s);
    expect(respuestas.some((r) => r.status === 429)).toBe(true);
    // ni en BD: el token solo como hash; la contraseña solo como PHC
    const filas = JSON.stringify(await p.sql("select * from auth.registro_pendiente where correo = $1", [u.correo]));
    expect(filas).not.toContain(token.b);
  });
});
