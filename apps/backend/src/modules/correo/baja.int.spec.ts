/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 028 (T6, rojo): baja pública por enlace (R-7, R-10, D-4, U-12, U-18; CA-6, CA-8). PG real.
// Contrato (plan 028, «Contratos: HTTP»; detalles fijados por T6 en `test/soporte-correo.ts`):
//  - `POST /correo/baja` con `{token}` (JSON; botón «Darme de baja» de `/baja`): `@Publico` (sin sesión ni CSRF), límite por IP. Token válido,
//    inexistente, alterado, vencido o el hash almacenado usado como token: 200 `{}` con la MISMA forma (estado, cuerpo y cabeceras). Un cuerpo
//    que no cumple `bajaSchema` (`.strict()`, 43 caracteres base64url): 400 `solicitud_invalida` sin efectos. Pasado el límite: 429
//    `demasiados_intentos` sin tocar nada.
//  - `POST /correo/baja?t=<token>` con cuerpo `application/x-www-form-urlencoded` EXACTO `List-Unsubscribe=One-Click` (RFC 8058) y sin `Origin`
//    ni `Sec-Fetch-Site`: aplica la baja. Con cualquier otro cuerpo (vacío, otro valor, texto plano, campos extra): 200 `{}` sin efectos. Un cuerpo
//    `application/json` es siempre la variante de la página (`bajaSchema`: 400 si no es `{token}`) [T6].
//  - `GET /correo/baja` (con o sin `?t=`): 405 sin efectos y sin eco del token.
//  - La baja apaga SOLO el tipo del token de SU (estudio, usuario), nunca activa, audita `{tipo, de, a: false, origen: "enlace"}` (actor el
//    usuario) solo si cambió algo, y es idempotente. El token (43 caracteres) y su URL nunca se registran (CA-6).
// Cada «no cambia nada» se acompaña de un control positivo (el mismo token íntegro sí apaga) para que una ruta ausente no pase por vacío.
// Rojo: la ruta aún no existe (T12): 404 de ruta; las tablas y funciones (T10) tampoco.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio, type RolSistema } from "../../../test/soporte-acceso.js";
import {
  alterar,
  auditoriaPreferencia,
  esNoStore,
  filasPreferencia,
  prefs,
  sembrarToken,
  tambienEn,
  tokenNuevo,
  vigentear,
  type TipoCorreo,
  type TokenSembrado,
} from "../../../test/soporte-correo.js";
import { capturarLogs, forma, ipUnica, type Peticion, type Resp } from "../../../test/soporte.js";

let b: Banco;
let E: Estudio;
let F: Estudio;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  F = await b.estudio();
});
const ipsUsadas: string[] = [];
afterAll(async () => {
  if (b && ipsUsadas.length > 0) await b.sql("delete from auth.limite_tasa where sujeto = any($1::text[])", [ipsUsadas]).catch(() => undefined);
  await b?.cerrar();
});

const sql = <T = any>(t: string, v?: unknown[]) => b.sql<T>(t, v);
/** Botón «Darme de baja» de `/baja`: JSON `{token}`, mismo origen, sin sesión. */
const baja = (token: unknown, extra: Partial<Peticion> = {}): Promise<Resp> =>
  b.h.pedir({ metodo: "POST", ruta: "/correo/baja", cuerpo: { token }, ...extra });
/** Botón del cliente de correo (RFC 8058): POST a la URL de `List-Unsubscribe`, sin `Origin`, sin cookies; `cuerpo` crudo. */
const unClic = (
  consulta: string,
  cuerpo: string | null = "List-Unsubscribe=One-Click",
  tipoContenido = "application/x-www-form-urlencoded",
  extra: Partial<Peticion> = {},
): Promise<Resp> =>
  b.h.pedir({
    metodo: "POST",
    ruta: `/correo/baja${consulta}`,
    ...(cuerpo === null ? {} : { cuerpo }),
    cabeceras: cuerpo === null ? {} : { "Content-Type": tipoContenido },
    origen: null,
    ...extra,
  });
/** La ruta existe y responde 200 `{}` a un token cualquiera: así el rojo es «ruta ausente». Devuelve esa respuesta (la de un token desconocido). */
const sonda = async (): Promise<Resp> => {
  const r = await baja(tokenNuevo());
  expect(r.status, `POST /correo/baja no responde 200 (¿ruta ausente?): ${r.text}`).toBe(200);
  expect(r.text).toBe("{}");
  return r;
};
const usuario = async (rol: RolSistema = "contador", estudio: Estudio = E, sesion = false): Promise<Actor> => b.miembro(estudio.tenantId, rol, { sesion });
const token = (u: Actor, tipo: TipoCorreo = "buzon_critico", venceEn: "vigente" | "vencido" = "vigente"): Promise<TokenSembrado> =>
  sembrarToken(sql, { tenantId: u.tenantId, usuarioId: u.id, tipo, venceEn });
const efectiva = async (tenantId: string, usuarioId: string, tipo: TipoCorreo): Promise<boolean> =>
  (await sql("select correo_preferencia_efectiva($1::uuid, $2::uuid, $3::text) as v", [tenantId, usuarioId, tipo]))[0].v;
const auditoria = (u: Actor) => auditoriaPreferencia(sql, u.tenantId, u.id);
/** El usuario no cambió: efectivas iniciales (por rol) y ninguna auditoría. */
const intacto = async (u: Actor, rol: RolSistema = "contador"): Promise<void> => {
  expect(await efectiva(u.tenantId, u.id, "buzon_critico")).toBe(true);
  expect(await efectiva(u.tenantId, u.id, "credencial_invalida")).toBe(true);
  expect(await efectiva(u.tenantId, u.id, "plan_limite")).toBe(rol === "dueno");
  expect(await efectiva(u.tenantId, u.id, "resumen")).toBe(false);
  expect(await auditoria(u)).toEqual([]);
};
const enlace = (tipo: TipoCorreo, de = true) => ({ tipo, de, a: false, origen: "enlace" });

describe("CA-8 · POST /correo/baja {token}: la baja por confirmación", () => {
  it("token válido: 200 {} sin sesión, apaga solo ese tipo del usuario y estudio del token y audita con origen enlace", async () => {
    await sonda();
    const u = await usuario("contador", E, true);
    await b.llamar(u, "PUT", "/cuenta/correo", prefs("contador")); // filas creadas: la baja actualiza una fila existente
    const t = await token(u, "buzon_critico");
    const r = await baja(t.token);
    expect(r.status, r.text).toBe(200);
    expect(r.text).toBe("{}");
    expect(esNoStore(r.headers["cache-control"])).toBe(true);
    expect(r.setCookies).toEqual([]);
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(false);
    expect(await efectiva(E.tenantId, u.id, "credencial_invalida")).toBe(true); // solo el tipo del token
    expect(await efectiva(E.tenantId, u.id, "resumen")).toBe(false);
    const f = await auditoria(u);
    expect(f.map((x) => x.datos)).toEqual([enlace("buzon_critico")]);
    expect(f[0]).toMatchObject({ actor_tipo: "usuario", usuario_id: u.id, tenant_id: E.tenantId });
    for (const prohibido of [t.token, t.hash.toString("hex"), t.hash.toString("base64url"), u.correo]) expect(JSON.stringify(f[0]!.datos)).not.toContain(prohibido);
    const v = await b.llamar(u, "GET", "/cuenta/correo"); // lo ve el propio usuario en la app
    expect(v.body).toMatchObject({ buzonCritico: false, credencialInvalida: true, planLimite: false, resumen: false });
  });

  it("sin filas previas: la baja deja la fila apagada y el resto en su efectiva inicial", async () => {
    await sonda();
    const u = await usuario("dueno");
    const t = await token(u, "credencial_invalida");
    expect((await baja(t.token)).status).toBe(200);
    expect(await efectiva(E.tenantId, u.id, "credencial_invalida")).toBe(false);
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(true);
    expect(await efectiva(E.tenantId, u.id, "plan_limite")).toBe(true); // el Dueño conserva el suyo
    expect((await auditoria(u)).map((x) => x.datos)).toEqual([enlace("credencial_invalida")]);
  });

  it("repetida: misma respuesta exacta, sin otra auditoría ni otro cambio (idempotente)", async () => {
    await sonda();
    const u = await usuario();
    const t = await token(u);
    const primera = await baja(t.token);
    const segunda = await baja(t.token);
    const tercera = await baja(t.token);
    expect(primera.status).toBe(200);
    expect(forma(segunda)).toEqual(forma(primera));
    expect(forma(tercera)).toEqual(forma(primera));
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(false);
    expect(await auditoria(u)).toHaveLength(1);
    expect(await filasPreferencia(sql, E.tenantId, u.id).then((fs) => fs.filter((x) => x.tipo === "buzon_critico"))).toHaveLength(1);
  });

  it("inválido, alterado, vencido o el hash almacenado como token: MISMO estado, cuerpo y cabeceras que el válido, y no cambian nada", async () => {
    const desconocido = await sonda();
    const ref = await usuario();
    const tRef = await token(ref);
    const valido = await baja(tRef.token);
    expect(forma(valido)).toEqual(forma(desconocido)); // ni siquiera el válido se distingue por fuera
    expect(await efectiva(E.tenantId, ref.id, "buzon_critico")).toBe(false);

    const alt = await usuario();
    const tAlt = await token(alt);
    const venc = await usuario();
    const tVenc = await token(venc, "buzon_critico", "vencido");
    const filtrado = await usuario();
    const tFil = await token(filtrado);
    const casos: [string, string][] = [
      ["inexistente", tokenNuevo()],
      ["alterado (un carácter)", alterar(tAlt.token)],
      ["vencido", tVenc.token],
      ["el hash almacenado usado como token", tFil.hash.toString("base64url")],
      ["el token de otro usuario con un carácter cambiado", alterar(tRef.token)],
    ];
    for (const [nombre, valor] of casos) {
      const r = await baja(valor);
      expect(forma(r), nombre).toEqual(forma(valido));
    }
    await intacto(alt);
    await intacto(venc);
    await intacto(filtrado);
    // Controles: cada uno fallaba por lo que se probó, no por una ruta ausente ni por otro motivo.
    expect((await baja(tAlt.token)).status).toBe(200);
    expect(await efectiva(E.tenantId, alt.id, "buzon_critico")).toBe(false);
    await vigentear(sql, tVenc);
    await baja(tVenc.token);
    expect(await efectiva(E.tenantId, venc.id, "buzon_critico")).toBe(false);
    await baja(tFil.token);
    expect(await efectiva(E.tenantId, filtrado.id, "buzon_critico")).toBe(false);
  }, 30_000);

  it("nunca activa: bajar un tipo que ya estaba apagado no cambia nada ni audita (resumen y límite del plan por defecto)", async () => {
    await sonda();
    const u = await usuario("contador");
    const tResumen = await token(u, "resumen");
    const tLimite = await token(u, "plan_limite");
    for (const t of [tResumen, tLimite]) expect((await baja(t.token)).status).toBe(200);
    expect(await efectiva(E.tenantId, u.id, "resumen")).toBe(false);
    expect(await efectiva(E.tenantId, u.id, "plan_limite")).toBe(false);
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(true);
    // Ninguna fila de esos dos tipos queda activa por la baja.
    expect((await filasPreferencia(sql, E.tenantId, u.id)).filter((f) => f.activo && (f.tipo === "resumen" || f.tipo === "plan_limite"))).toEqual([]);
    expect(await auditoria(u)).toEqual([]);
    // Control: con el resumen activado por la app, el mismo token SÍ lo apaga (y audita una vez).
    const a = await usuario("contador", E, true);
    await b.llamar(a, "PUT", "/cuenta/correo", prefs("contador", { resumen: true }));
    const tA = await token(a, "resumen");
    await baja(tA.token);
    expect(await efectiva(E.tenantId, a.id, "resumen")).toBe(false);
    expect((await auditoria(a)).map((x) => x.datos)).toEqual([
      { tipo: "resumen", de: false, a: true, origen: "app" },
      enlace("resumen"),
    ]);
  });

  it("un token de resumen apaga el resumen y deja los avisos; uno de aviso no toca el resumen ni los demás avisos", async () => {
    await sonda();
    const u = await usuario("dueno", E, true);
    await b.llamar(u, "PUT", "/cuenta/correo", prefs("dueno", { resumen: true }));
    await baja((await token(u, "buzon_critico")).token);
    expect(await efectiva(E.tenantId, u.id, "resumen")).toBe(true);
    expect(await efectiva(E.tenantId, u.id, "credencial_invalida")).toBe(true);
    expect(await efectiva(E.tenantId, u.id, "plan_limite")).toBe(true);
    await baja((await token(u, "resumen")).token);
    expect(await efectiva(E.tenantId, u.id, "resumen")).toBe(false);
    expect(await efectiva(E.tenantId, u.id, "credencial_invalida")).toBe(true);
  });

  it("el token es de SU (estudio, usuario): el mismo usuario en otro estudio y los demás usuarios del estudio no cambian", async () => {
    await sonda();
    const x = await usuario("contador", E, true);
    const xEnF = await tambienEn(b, x, F.tenantId, "contador");
    const y = await usuario("contador", F);
    const t = await token(xEnF, "buzon_critico"); // el correo era del estudio F
    expect((await baja(t.token)).status).toBe(200);
    expect(await efectiva(F.tenantId, x.id, "buzon_critico")).toBe(false);
    expect(await efectiva(E.tenantId, x.id, "buzon_critico")).toBe(true); // en E sigue activa
    expect(await efectiva(F.tenantId, y.id, "buzon_critico")).toBe(true); // otro usuario de F tampoco
    expect(await auditoriaPreferencia(sql, E.tenantId, x.id)).toEqual([]);
    expect((await auditoriaPreferencia(sql, F.tenantId, x.id)).map((f) => f.datos)).toEqual([enlace("buzon_critico")]);
  });

  it("la sesión de quien llama no cuenta: con la cookie de otro usuario, la baja es la del DUEÑO del token", async () => {
    await sonda();
    const llamante = await usuario("contador", E, true);
    const duenoDelToken = await usuario("contador");
    const t = await token(duenoDelToken);
    const r = await baja(t.token, { cookie: llamante.cookie, csrf: llamante.csrf, estudio: E.tenantId });
    expect(r.status, r.text).toBe(200);
    expect(await efectiva(E.tenantId, duenoDelToken.id, "buzon_critico")).toBe(false);
    expect(await efectiva(E.tenantId, llamante.id, "buzon_critico")).toBe(true);
    expect(await auditoria(llamante)).toEqual([]);
  });

  it("un cuerpo que no cumple bajaSchema es 400 solicitud_invalida y no aplica nada (control: el token íntegro sí)", async () => {
    await sonda();
    const u = await usuario();
    const t = await token(u);
    const malos: unknown[] = [
      {},
      { token: t.token.slice(0, 42) },
      { token: `${t.token}A` },
      { token: `${t.token.slice(0, 42)}!` },
      { token: `${t.token.slice(0, 42)}=` },
      { token: t.hash.toString("hex") },
      { token: 42 },
      { token: null },
      { token: [t.token] },
      { token: t.token, usuarioId: u.id },
      { token: t.token, tenantId: E.tenantId },
      { t: t.token },
      [t.token],
    ];
    for (const cuerpo of malos) {
      const r = await b.h.pedir({ metodo: "POST", ruta: "/correo/baja", cuerpo });
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      expect(esNoStore(r.headers["cache-control"])).toBe(true);
    }
    const noJson = await b.h.pedir({ metodo: "POST", ruta: "/correo/baja", crudo: "{" });
    expect(noJson.status).toBe(400);
    await intacto(u);
    expect((await baja(t.token)).status).toBe(200);
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(false);
  }, 30_000);

  it("el token en la consulta no sirve a la ruta de la página: sin token en el cuerpo, 400 y sin efectos", async () => {
    await sonda();
    const u = await usuario();
    const t = await token(u);
    const r = await b.h.pedir({ metodo: "POST", ruta: `/correo/baja?t=${t.token}`, cuerpo: {} });
    expect(r.status, r.text).toBe(400);
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(true);
    expect(await auditoria(u)).toEqual([]);
    expect((await baja(t.token)).status).toBe(200); // control
  });
});

describe("CA-8 · POST /correo/baja?t= con el cuerpo de RFC 8058 (un clic del cliente de correo)", () => {
  it("el cuerpo exacto List-Unsubscribe=One-Click, sin Origin ni cookies, aplica la baja: 200 {} y audita con origen enlace", async () => {
    await sonda();
    const u = await usuario();
    const t = await token(u);
    const r = await unClic(`?t=${t.token}`);
    expect(r.status, r.text).toBe(200);
    expect(r.text).toBe("{}");
    expect(esNoStore(r.headers["cache-control"])).toBe(true);
    expect(r.setCookies).toEqual([]);
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(false);
    expect((await auditoria(u)).map((x) => x.datos)).toEqual([enlace("buzon_critico")]);
    expect(forma(await unClic(`?t=${t.token}`))).toEqual(forma(r)); // repetido: igual
    expect(await auditoria(u)).toHaveLength(1);
  });

  it("sin ese cuerpo exacto (vacío, otro valor, texto plano, campos extra, mayúsculas) responde 200 {} y no cambia nada", async () => {
    await sonda();
    const u = await usuario();
    const t = await token(u);
    const q = `?t=${t.token}`;
    const casos: [string, Resp][] = [
      ["sin cuerpo", await unClic(q, null)],
      ["cuerpo vacío", await unClic(q, "")],
      ["otro valor", await unClic(q, "List-Unsubscribe=Other")],
      ["otra clave", await unClic(q, "List-Unsubscribe-Post=One-Click")],
      ["en minúsculas", await unClic(q, "list-unsubscribe=one-click")],
      ["con campo extra", await unClic(q, "List-Unsubscribe=One-Click&x=1")],
      ["con espacio delante", await unClic(q, " List-Unsubscribe=One-Click")],
      ["con valor repetido", await unClic(q, "List-Unsubscribe=One-Click&List-Unsubscribe=One-Click")],
      ["texto plano con el texto exacto", await unClic(q, "List-Unsubscribe=One-Click", "text/plain")],
    ];
    for (const [nombre, r] of casos) {
      expect(r.status, `${nombre}: ${r.text}`).toBe(200);
      expect(r.text, nombre).toBe("{}");
    }
    // Un cuerpo JSON es la variante de la página (`bajaSchema`): con otra cosa que `{token}` es 400 y tampoco cambia nada.
    const json = await unClic(q, JSON.stringify({ "List-Unsubscribe": "One-Click" }), "application/json");
    expect([200, 400], json.text).toContain(json.status);
    await intacto(u);
    // Control: la misma petición con el cuerpo exacto sí aplica y responde lo mismo que los demás.
    const ok = await unClic(q);
    expect(forma(ok)).toEqual(forma(casos[0]![1]));
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(false);
  }, 30_000);

  it("token ausente, mal formado, desconocido, alterado o vencido: 200 {} igual (el cliente de correo no debe ver un error) y sin efectos", async () => {
    const ref = await sonda();
    const alt = await usuario();
    const tAlt = await token(alt);
    const venc = await usuario();
    const tVenc = await token(venc, "buzon_critico", "vencido");
    for (const consulta of ["", "?t=", "?t=corto", `?t=${tokenNuevo()}`, `?t=${alterar(tAlt.token)}`, `?t=${tVenc.token}`, `?x=${tAlt.token}`, `?t=${tAlt.token}&t=${tokenNuevo()}`]) {
      const r = await unClic(consulta);
      expect(r.status, `${consulta}: ${r.text}`).toBe(200);
      expect(forma(r), consulta).toEqual(forma(ref));
    }
    await intacto(alt);
    await intacto(venc);
    expect((await unClic(`?t=${tAlt.token}`)).status).toBe(200); // control
    expect(await efectiva(E.tenantId, alt.id, "buzon_critico")).toBe(false);
  }, 30_000);

  it("la baja de un clic tampoco pide sesión, CSRF ni X-Estudio, y es del dueño del token aunque venga una cookie ajena", async () => {
    await sonda();
    const llamante = await usuario("contador", E, true);
    const u = await usuario();
    const t = await token(u);
    const r = await unClic(`?t=${t.token}`, "List-Unsubscribe=One-Click", "application/x-www-form-urlencoded", { cookie: llamante.cookie });
    expect(r.status, r.text).toBe(200);
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(false);
    expect(await efectiva(E.tenantId, llamante.id, "buzon_critico")).toBe(true);
  });
});

describe("CA-8 · ningún GET cambia estado (la carga de /baja y los antivirus que solo hacen GET no apagan nada)", () => {
  it("GET /correo/baja, con o sin token, es 405 sin efectos y sin eco; el POST del mismo token sí apaga (control)", async () => {
    await sonda();
    const u = await usuario();
    const t = await token(u);
    for (const ruta of ["/correo/baja", `/correo/baja?t=${t.token}`, `/correo/baja?t=${t.token}&List-Unsubscribe=One-Click`, `/correo/baja?token=${t.token}`]) {
      const r = await b.h.pedir({ metodo: "GET", ruta });
      expect(r.status, `${ruta}: ${r.text}`).toBe(405);
      expect(`${r.text}${JSON.stringify(r.headers)}`, ruta).not.toContain(t.token);
    }
    await intacto(u);
    expect((await baja(t.token)).status).toBe(200);
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(false);
  });
});

describe("CA-8 · límite por IP: 429 sin tocar nada", () => {
  it("pasado el límite la IP recibe 429 demasiados_intentos aun con un token bueno (también por RFC 8058) y no cambia nada; otra IP sí puede", async () => {
    await sonda();
    const ip = ipUnica();
    ipsUsadas.push(ip);
    const u = await usuario();
    const tBueno = await token(u);
    const w = await usuario();
    const tW = await token(w);
    const estados: number[] = [];
    for (let i = 0; i < 80 && estados.at(-1) !== 429; i++) estados.push((await baja(tokenNuevo(), { ip })).status);
    expect(estados.at(-1), `el límite por IP no llegó en ${estados.length} intentos`).toBe(429);
    expect(estados.length, "el límite no puede cortar el primer intento").toBeGreaterThan(1);
    expect(estados.slice(0, -1).every((s) => s === 200)).toBe(true);
    const bloqueada = await baja(tBueno.token, { ip });
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.body).toEqual({ codigo: "demasiados_intentos" });
    expect(esNoStore(bloqueada.headers["cache-control"])).toBe(true);
    const bloqueadaUnClic = await unClic(`?t=${tBueno.token}`, "List-Unsubscribe=One-Click", "application/x-www-form-urlencoded", { ip });
    expect(bloqueadaUnClic.status).toBe(429); // el contador de la IP es el mismo para la página y para el cliente de correo
    expect(bloqueadaUnClic.body).toEqual({ codigo: "demasiados_intentos" });
    await intacto(u);
    // Otra IP no está limitada: el mismo token apaga.
    expect((await baja(tBueno.token)).status).toBe(200);
    expect(await efectiva(E.tenantId, u.id, "buzon_critico")).toBe(false);
    // Y la IP bloqueada tampoco aplicó la de otro usuario.
    expect(await efectiva(E.tenantId, w.id, "buzon_critico")).toBe(true);
    expect((await baja(tW.token)).status).toBe(200);
  }, 60_000);
});

describe("CA-6 · el token y su URL no se registran ni se devuelven", () => {
  it("ni en logs ni en respuestas ni en la auditoría: JSON, un clic, GET, inválidos y cuerpos malos", async () => {
    await sonda();
    const u1 = await usuario();
    const u2 = await usuario();
    const t1 = await token(u1);
    const t2 = await token(u2);
    const inventado = tokenNuevo();
    const { resultado, logs } = await capturarLogs(async () => {
      const rs: Resp[] = [];
      rs.push(await baja(t1.token));
      rs.push(await unClic(`?t=${t2.token}`));
      rs.push(await b.h.pedir({ metodo: "GET", ruta: `/correo/baja?t=${t1.token}` }));
      rs.push(await baja(inventado));
      rs.push(await unClic(`?t=${inventado}`));
      rs.push(await b.h.pedir({ metodo: "POST", ruta: "/correo/baja", cuerpo: { token: `${t1.token}!`, usuarioId: u1.id } }));
      rs.push(await b.h.pedir({ metodo: "POST", ruta: `/correo/baja?t=${t1.token}`, cuerpo: {} }));
      await new Promise((r) => setTimeout(r, 300));
      return rs;
    });
    expect(await efectiva(E.tenantId, u1.id, "buzon_critico")).toBe(false); // control: las dos bajas válidas se aplicaron
    expect(await efectiva(E.tenantId, u2.id, "buzon_critico")).toBe(false);
    const secretos = [t1.token, t2.token, inventado, t1.hash.toString("hex"), t1.hash.toString("base64url"), t2.hash.toString("hex"), t2.hash.toString("base64url")];
    const vistos = resultado.map((r) => `${r.text}\n${JSON.stringify(r.headers)}`).join("\n");
    const auditados = JSON.stringify([...(await auditoria(u1)), ...(await auditoria(u2))]);
    for (const s of secretos) {
      expect(logs, "logs").not.toContain(s);
      expect(vistos, "respuestas").not.toContain(s);
      expect(auditados, "auditoría").not.toContain(s);
    }
    expect(logs).not.toContain("correo/baja?");
    expect(logs).not.toContain("One-Click");
  });
});
