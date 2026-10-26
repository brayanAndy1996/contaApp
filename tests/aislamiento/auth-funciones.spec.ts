// Spec 004 (T5, rojo): comportamiento de las funciones SECURITY DEFINER del esquema `auth` y de `withAuth`
// contra la BD real (CA-3, CA-5, CA-6, CA-8, CA-9, CA-11). Se llama a la funcion SQL tal como la llamara
// el backend: transaccion con SET LOCAL ROLE contapp_backend. Los plazos se prueban moviendo marcas de
// tiempo con la conexion administrativa (MIGRATIONS_DATABASE_URL). Todo dato propio se borra al final.
//
// Contrato que fija (T9). Firmas SQL (nombres de columnas de salida incluidos):
//   auth.limite_consumir(tipo text, sujeto text) -> boolean
//   auth.login_preparar(correo text, clave bytea) -> (permitido, usuario_id, hash, alcanza_bloqueo)
//   auth.login_exito(clave bytea, usuario_id uuid, token_hash bytea, tenant_activo uuid, hash_nuevo text,
//                    token_anterior_hash bytea) -> (sesion_id, expira_absoluta)
//   auth.sesion_validar(token_hash) -> (sesion_id, usuario_id, tenant_activo, estudio_revocado, expira_absoluta)
//   auth.sesion_rotar(token_hash, token_hash_nuevo, tenant_nuevo uuid) -> (sesion_id, expira_absoluta)
//   auth.sesion_revocar(token_hash) · auth.sesiones_cerrar_todas(token_hash) -> int (incluye la propia)
//   auth.ultimo_estudio(token_hash) -> uuid | null
//   auth.recuperacion_crear(correo text, token_hash bytea) -> boolean
//   auth.recuperacion_consumir(token_hash bytea, hash_nuevo text) -> (usuario_id, correo)
//   auth.contrasena_cambiar(token_hash, hash_nuevo text, token_hash_nuevo) -> correo text
// "Rechazar" = lanzar un error de PG o devolver cero filas (la prueba admite ambas), sin efectos.
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Escenario,
  abrirAdmin,
  abrirApp,
  conAuth,
  crearDb,
  exito,
  exportado,
  hashFalso,
  llamar,
  nuevoToken,
  tenantDe,
} from "./auth-soporte";
import type { ContappDb } from "./soporte";

let app: Pool;
let admin: Pool;
let esc: Escenario;
const dbs: ContappDb[] = [];

beforeAll(() => {
  app = abrirApp(30);
  admin = abrirAdmin(4);
  esc = new Escenario(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await app?.end();
  await admin?.end();
});

const A = () => tenantDe("A");
const B = () => tenantDe("B");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
const escalar = async (sql: string, v: unknown[] = []) => (await exito(llamar(app, sql, v)))[0]?.v;
const rechazada = (r: { ok: boolean; rows?: unknown[] }) => !r.ok || (r.rows ?? []).length === 0;

// --- envolturas SQL (fijan el contrato de nombres) -------------------------------------------------
const limite = (tipo: string, sujeto: string) =>
  escalar("select auth.limite_consumir($1::text, $2::text) as v", [tipo, sujeto]) as Promise<boolean>;
const preparar = async (correo: string, k: Buffer) =>
  (
    await exito(
      llamar(app, "select permitido, usuario_id, hash, alcanza_bloqueo from auth.login_preparar($1::text, $2::bytea)", [
        correo,
        k,
      ]),
    )
  )[0];
const LOGIN_EXITO =
  "select sesion_id, expira_absoluta from auth.login_exito($1::bytea, $2::uuid, $3::bytea, $4::uuid, $5::text, $6::bytea)";
const loginExito = (
  k: Buffer,
  usuarioId: string,
  token: Buffer,
  tenant: string | null,
  hashNuevo: string | null = null,
  anterior: Buffer | null = null,
) => llamar(app, LOGIN_EXITO, [k, usuarioId, token, tenant, hashNuevo, anterior]);
const validar = async (t: Buffer) =>
  exito(
    llamar(
      app,
      "select sesion_id, usuario_id, tenant_activo, estudio_revocado, expira_absoluta from auth.sesion_validar($1::bytea)",
      [t],
    ),
  );
const rotar = (t: Buffer, nuevo: Buffer, tenant: string | null) =>
  llamar(app, "select sesion_id, expira_absoluta from auth.sesion_rotar($1::bytea, $2::bytea, $3::uuid)", [t, nuevo, tenant]);
const revocar = (t: Buffer) => exito(llamar(app, "select auth.sesion_revocar($1::bytea)", [t]));
const cerrarTodas = async (t: Buffer) => Number(await escalar("select auth.sesiones_cerrar_todas($1::bytea) as v", [t]));
const ultimoEstudio = (t: Buffer) => escalar("select auth.ultimo_estudio($1::bytea) as v", [t]) as Promise<string | null>;
const crearRecuperacion = (correo: string, t: Buffer) =>
  escalar("select auth.recuperacion_crear($1::text, $2::bytea) as v", [correo, t]) as Promise<boolean>;
const consumir = (t: Buffer, hashNuevo: string) =>
  llamar(app, "select usuario_id, correo from auth.recuperacion_consumir($1::bytea, $2::text)", [t, hashNuevo]);
const cambiar = (t: Buffer, hashNuevo: string, nuevo: Buffer) =>
  llamar(app, "select auth.contrasena_cambiar($1::bytea, $2::text, $3::bytea) as v", [t, hashNuevo, nuevo]);

// --- lecturas administrativas ---------------------------------------------------------------------
const filaSesion = async (t: Buffer) => (await adm("select * from auth.sesion where token_hash = $1", [t]))[0];
const intento = async (k: Buffer) => (await adm("select * from auth.intento_login where clave = $1", [k]))[0];
const hashDe = async (usuarioId: string) =>
  (await adm("select hash from auth.usuario_contrasena where usuario_id = $1", [usuarioId]))[0]?.hash as string | undefined;
const segundosHasta = async (columna: string, tabla: string, donde: string, v: unknown[]) =>
  Number((await adm(`select extract(epoch from (${columna} - now())) as s from ${tabla} where ${donde}`, v))[0].s);
const expirarBloqueo = (k: Buffer) =>
  adm(
    "update auth.intento_login set bloqueado_hasta = now() - interval '1 second', ventana_inicio = now() - interval '16 minutes' where clave = $1",
    [k],
  );

// =================================================================================================
describe("auth.limite_consumir (D7: contador atomico en PostgreSQL)", () => {
  it.each([
    ["login_ip", 20],
    ["recup_correo", 3],
    ["recup_ip", 10],
  ])("%s admite %i consumos y rechaza el siguiente", async (tipo, max) => {
    const s = esc.sujeto(tipo);
    for (let i = 1; i <= max; i++) expect(await limite(tipo, s), `consumo ${i}`).toBe(true);
    expect(await limite(tipo, s)).toBe(false);
    expect(await limite(tipo, s)).toBe(false);
  });

  it("los sujetos y los tipos tienen contadores independientes", async () => {
    const s1 = esc.sujeto("recup_correo");
    const s2 = esc.sujeto("recup_correo");
    for (let i = 0; i < 3; i++) await limite("recup_correo", s1);
    expect(await limite("recup_correo", s1)).toBe(false);
    expect(await limite("recup_correo", s2)).toBe(true);
    expect(await limite("recup_ip", s1)).toBe(true);
  });

  it("la ventana de login_ip dura 10 min: a los 11 min el contador reinicia, a los 9 sigue lleno", async () => {
    const s = esc.sujeto("login_ip");
    for (let i = 0; i < 20; i++) await limite("login_ip", s);
    expect(await limite("login_ip", s)).toBe(false);
    await adm("update auth.limite_tasa set ventana_inicio = now() - interval '9 minutes' where tipo = 'login_ip' and sujeto = $1", [s]);
    expect(await limite("login_ip", s)).toBe(false);
    await adm("update auth.limite_tasa set ventana_inicio = now() - interval '11 minutes' where tipo = 'login_ip' and sujeto = $1", [s]);
    expect(await limite("login_ip", s)).toBe(true);
    const c = await adm("select conteo from auth.limite_tasa where tipo = 'login_ip' and sujeto = $1", [s]);
    expect(c[0].conteo).toBe(1);
  });

  it.each(["recup_correo", "recup_ip"])("la ventana de %s dura 1 h: a los 61 min reinicia, a los 59 sigue lleno", async (tipo) => {
    const s = esc.sujeto(tipo);
    const max = tipo === "recup_correo" ? 3 : 10;
    for (let i = 0; i < max; i++) await limite(tipo, s);
    expect(await limite(tipo, s)).toBe(false);
    await adm("update auth.limite_tasa set ventana_inicio = now() - interval '59 minutes' where tipo = $1 and sujeto = $2", [tipo, s]);
    expect(await limite(tipo, s)).toBe(false);
    await adm("update auth.limite_tasa set ventana_inicio = now() - interval '61 minutes' where tipo = $1 and sujeto = $2", [tipo, s]);
    expect(await limite(tipo, s)).toBe(true);
  });

  it("con 30 llamadas simultaneas a login_ip, exactamente 20 pasan", async () => {
    const s = esc.sujeto("login_ip");
    const r = await Promise.all(Array.from({ length: 30 }, () => limite("login_ip", s)));
    expect(r.filter(Boolean)).toHaveLength(20);
  });

  it("un tipo desconocido no concede el consumo (y uno valido si, como control)", async () => {
    expect(await limite("login_ip", esc.sujeto("login_ip"))).toBe(true);
    const r = await llamar(app, "select auth.limite_consumir('otro', $1::text) as v", [esc.sujeto("otro")]);
    expect(!r.ok || r.rows[0].v === false).toBe(true);
  });
});

// =================================================================================================
describe("auth.login_preparar (D7, D9, CA-3: reserva atomica del intento)", () => {
  it("con el correo exacto y credencial devuelve permitido, usuario_id y el hash", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const r = await preparar(u.correo, esc.clave(u.correo));
    expect(r).toEqual({ permitido: true, usuario_id: u.id, hash: u.hash, alcanza_bloqueo: false });
  });

  it.each([
    ["en mayusculas", (c: string) => c.toUpperCase()],
    ["con espacios alrededor", (c: string) => ` ${c} `],
    ["con % en lugar de la primera letra", (c: string) => `%${c.slice(1)}`],
    ["con _ en lugar de la primera letra", (c: string) => `_${c.slice(1)}`],
    ["con % al final del prefijo", (c: string) => `${c.slice(0, 4)}%`],
    ["solo %", () => "%"],
  ])("un correo %s no devuelve hash ni usuario (solo el correo exacto)", async (_n, variante) => {
    const u = await esc.usuario({ estudios: [A()] });
    const v = variante(u.correo);
    const r = await preparar(v, esc.clave(v));
    expect(r.permitido).toBe(true);
    expect(r.hash).toBeNull();
    expect(r.usuario_id).toBeNull();
  });

  it("un correo inexistente o un usuario sin credencial devuelve permitido sin hash, y el intento se cuenta", async () => {
    const inexistente = esc.correoNuevo();
    const k1 = esc.clave(inexistente);
    const r1 = await preparar(inexistente, k1);
    expect(r1).toMatchObject({ permitido: true, hash: null, usuario_id: null });
    expect((await intento(k1)).fallos).toBe(1);

    const sinCred = await esc.usuario({ estudios: [A()], contrasena: false });
    const k2 = esc.clave(sinCred.correo);
    const r2 = await preparar(sinCred.correo, k2);
    expect(r2.permitido).toBe(true);
    expect(r2.hash).toBeNull();
    expect((await intento(k2)).fallos).toBe(1);
  });

  it("el 5.o fallo en la ventana bloquea 15 min; el 6.o se rechaza sin hash (CA-3)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const k = esc.clave(u.correo);
    for (let i = 1; i <= 4; i++) {
      const r = await preparar(u.correo, k);
      expect(r, `intento ${i}`).toMatchObject({ permitido: true, hash: u.hash, alcanza_bloqueo: false });
    }
    expect((await intento(k)).bloqueado_hasta).toBeNull();
    const quinto = await preparar(u.correo, k);
    expect(quinto).toMatchObject({ permitido: true, hash: u.hash, alcanza_bloqueo: true });
    const fila = await intento(k);
    expect(fila.fallos).toBe(5);
    const seg = await segundosHasta("bloqueado_hasta", "auth.intento_login", "clave = $1", [k]);
    expect(seg).toBeGreaterThan(880);
    expect(seg).toBeLessThanOrEqual(901);
    const sexto = await preparar(u.correo, k);
    expect(sexto.permitido).toBe(false);
    expect(sexto.hash).toBeNull();
    expect(sexto.alcanza_bloqueo).toBe(false);
  });

  it("una ventana vencida (16 min) reinicia el contador; con 14 min sigue acumulando", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const k = esc.clave(u.correo);
    for (let i = 0; i < 3; i++) await preparar(u.correo, k);
    await adm("update auth.intento_login set ventana_inicio = now() - interval '14 minutes' where clave = $1", [k]);
    await preparar(u.correo, k);
    expect((await intento(k)).fallos).toBe(4);
    await adm("update auth.intento_login set ventana_inicio = now() - interval '16 minutes' where clave = $1", [k]);
    const r = await preparar(u.correo, k);
    expect(r.permitido).toBe(true);
    expect((await intento(k)).fallos).toBe(1);
  });

  it("pasados los 15 min de bloqueo vuelve a permitir y reinicia el contador", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const k = esc.clave(u.correo);
    for (let i = 0; i < 5; i++) await preparar(u.correo, k);
    expect((await preparar(u.correo, k)).permitido).toBe(false);
    await expirarBloqueo(k);
    const r = await preparar(u.correo, k);
    expect(r).toMatchObject({ permitido: true, hash: u.hash });
    const fila = await intento(k);
    expect(fila.fallos).toBe(1);
    expect(fila.bloqueado_hasta).toBeNull();
  });

  it("alcanza_bloqueo (aviso al titular) es true una vez cada 24 h por cuenta (P3, P13)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const k = esc.clave(u.correo);
    const ciclo = async () => {
      let ultimo: any;
      for (let i = 0; i < 5; i++) ultimo = await preparar(u.correo, k);
      return ultimo.alcanza_bloqueo as boolean;
    };
    expect(await ciclo(), "primer bloqueo").toBe(true);
    await expirarBloqueo(k);
    expect(await ciclo(), "segundo bloqueo dentro de 24 h").toBe(false);
    await expirarBloqueo(k);
    await adm("update auth.intento_login set aviso_enviado_en = now() - interval '25 hours' where clave = $1", [k]);
    expect(await ciclo(), "bloqueo pasadas 24 h").toBe(true);
  });

  it.each([
    ["usuario existente", true],
    ["correo inexistente", false],
  ])("20 llamadas concurrentes (%s): exactamente 5 permitidas y un solo aviso (CA-3)", async (_n, existe) => {
    const u = existe ? await esc.usuario({ estudios: [A()] }) : null;
    const correo = u?.correo ?? esc.correoNuevo();
    const k = esc.clave(correo);
    const r = await Promise.all(Array.from({ length: 20 }, () => preparar(correo, k)));
    expect(r.filter((x) => x.permitido)).toHaveLength(5);
    expect(r.filter((x) => x.alcanza_bloqueo)).toHaveLength(1);
    expect(r.filter((x) => x.hash !== null)).toHaveLength(existe ? 5 : 0);
    expect((await intento(k)).bloqueado_hasta).not.toBeNull();
  });
});

// =================================================================================================
describe("auth.login_exito (D2, D4, CA-1, CA-5)", () => {
  it("reinicia el contador, crea la sesion (12 h, solo el hash del token) y devuelve su id", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const k = esc.clave(u.correo);
    for (let i = 0; i < 3; i++) await preparar(u.correo, k);
    const token = nuevoToken();
    const r = await exito(loginExito(k, u.id, token, A()));
    expect(r).toHaveLength(1);
    expect(r[0].sesion_id).toMatch(UUID);
    expect(r[0].expira_absoluta).toBeInstanceOf(Date);
    const f = await intento(k);
    expect(f?.fallos ?? 0).toBe(0);
    const s = await filaSesion(token);
    expect(s.usuario_id).toBe(u.id);
    expect(s.tenant_activo).toBe(A());
    expect(s.revocada_en).toBeNull();
    expect(Buffer.from(s.token_hash).length).toBe(32);
    const seg = await segundosHasta("expira_absoluta", "auth.sesion", "token_hash = $1", [token]);
    expect(seg).toBeGreaterThan(12 * 3600 - 60);
    expect(seg).toBeLessThanOrEqual(12 * 3600 + 1);
  });

  it("admite tenant_activo NULL (usuario sin estudio elegido)", async () => {
    const u = await esc.usuario({ estudios: [A(), B()] });
    const token = nuevoToken();
    await exito(loginExito(esc.clave(u.correo), u.id, token, null));
    expect((await filaSesion(token)).tenant_activo).toBeNull();
  });

  it("con hash_nuevo re-calcula la contrasena (CA-4); con NULL no la toca", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const k = esc.clave(u.correo);
    await exito(loginExito(k, u.id, nuevoToken(), A(), null));
    expect(await hashDe(u.id)).toBe(u.hash);
    const nuevo = hashFalso();
    await exito(loginExito(k, u.id, nuevoToken(), A(), nuevo));
    expect(await hashDe(u.id)).toBe(nuevo);
  });

  it("revoca token_anterior_hash (la cookie previa no se promueve, CA-5)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const previo = await esc.sesion(u.id, A());
    const token = nuevoToken();
    await exito(loginExito(esc.clave(u.correo), u.id, token, A(), null, previo));
    expect((await filaSesion(previo)).revocada_en).not.toBeNull();
    expect(await validar(previo)).toHaveLength(0);
    expect(await validar(token)).toHaveLength(1);
  });

  it("rechaza un estudio sin membresia y no deja sesion", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const token = nuevoToken();
    const r = await loginExito(esc.clave(u.correo), u.id, token, B());
    expect(rechazada(r)).toBe(true);
    expect(await filaSesion(token)).toBeUndefined();
  });

  it("un token_hash de 31 B se rechaza (CHECK 23514) y no deja sesion (CA-6)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const corto = randomBytes(31);
    const r = await loginExito(esc.clave(u.correo), u.id, corto, A());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toBe("23514");
    expect(await filaSesion(corto)).toBeUndefined();
  });
});

// =================================================================================================
describe("auth.sesion_validar (D3, CA-5, CA-9)", () => {
  it("una sesion vigente devuelve una fila con usuario, estudio y caducidad absoluta", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.sesion(u.id, A());
    const r = await validar(t);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ usuario_id: u.id, tenant_activo: A(), estudio_revocado: false });
    expect(r[0].sesion_id).toMatch(UUID);
    expect(r[0].expira_absoluta).toBeInstanceOf(Date);
  });

  it("un token desconocido devuelve cero filas", async () => {
    expect(await validar(nuevoToken())).toHaveLength(0);
  });

  it("una sesion revocada devuelve cero filas", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.sesion(u.id, A());
    await revocar(t);
    expect(await validar(t)).toHaveLength(0);
  });

  it("2 h de inactividad: a los 121 min cero filas; a los 119 min una", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.sesion(u.id, A());
    await adm("update auth.sesion set ultimo_uso = now() - interval '119 minutes' where token_hash = $1", [t]);
    expect(await validar(t)).toHaveLength(1);
    await adm("update auth.sesion set ultimo_uso = now() - interval '121 minutes' where token_hash = $1", [t]);
    expect(await validar(t)).toHaveLength(0);
  });

  it("caducidad absoluta de 12 h: con expira_absoluta pasada cero filas, aunque haya actividad reciente", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.sesion(u.id, A());
    await adm("update auth.sesion set expira_absoluta = now() - interval '1 second' where token_hash = $1", [t]);
    expect(await validar(t)).toHaveLength(0);
  });

  it("ultimo_uso solo se actualiza si tiene mas de 5 min", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.sesion(u.id, A());
    await adm("update auth.sesion set ultimo_uso = now() - interval '3 minutes' where token_hash = $1", [t]);
    const antes = (await filaSesion(t)).ultimo_uso as Date;
    await validar(t);
    expect(((await filaSesion(t)).ultimo_uso as Date).getTime()).toBe(antes.getTime());
    await adm("update auth.sesion set ultimo_uso = now() - interval '6 minutes' where token_hash = $1", [t]);
    await validar(t);
    const reciente = await adm(
      "select extract(epoch from (now() - ultimo_uso)) as s from auth.sesion where token_hash = $1",
      [t],
    );
    expect(Number(reciente[0].s)).toBeLessThan(30);
  });

  it("membresia borrada: devuelve estudio_revocado, el estudio queda NULL en la sesion (CA-9)", async () => {
    const u = await esc.usuario({ estudios: [A(), B()] });
    const t = await esc.sesion(u.id, B());
    expect((await validar(t))[0]).toMatchObject({ tenant_activo: B(), estudio_revocado: false });
    await adm("delete from membresia where tenant_id = $1 and usuario_id = $2", [B(), u.id]);
    const r = await validar(t);
    expect(r).toHaveLength(1);
    expect(r[0].tenant_activo).toBeNull();
    expect(r[0].estudio_revocado).toBe(true);
    expect((await filaSesion(t)).tenant_activo).toBeNull();
    // la sesion sigue vigente (solo perdio el estudio): hay que elegir de nuevo
    expect((await validar(t))[0].tenant_activo).toBeNull();
  });
});

// =================================================================================================
describe("auth.sesion_rotar (D4, CA-5: la rotacion no extiende la caducidad absoluta)", () => {
  it("inserta la nueva con la misma creada_en y expira_absoluta, revoca la anterior y cambia de estudio", async () => {
    const u = await esc.usuario({ estudios: [A(), B()] });
    const t1 = await esc.sesion(u.id, A());
    await adm(
      "update auth.sesion set creada_en = now() - interval '3 hours', expira_absoluta = now() + interval '9 hours' where token_hash = $1",
      [t1],
    );
    const original = await filaSesion(t1);
    const t2 = nuevoToken();
    const r = await exito(rotar(t1, t2, B()));
    expect(r).toHaveLength(1);
    expect(r[0].sesion_id).toMatch(UUID);
    expect((r[0].expira_absoluta as Date).getTime()).toBe((original.expira_absoluta as Date).getTime());
    const cmp = await adm(
      `select (n.creada_en = o.creada_en) as misma_creada, (n.expira_absoluta = o.expira_absoluta) as misma_abs,
              n.tenant_activo as tenant, o.revocada_en as revocada
         from auth.sesion n, auth.sesion o where n.token_hash = $1 and o.token_hash = $2`,
      [t2, t1],
    );
    expect(cmp[0]).toMatchObject({ misma_creada: true, misma_abs: true, tenant: B() });
    expect(cmp[0].revocada).not.toBeNull();
    expect(await validar(t1)).toHaveLength(0);
    expect((await validar(t2))[0].tenant_activo).toBe(B());
  });

  it("re-comprueba la membresia: un estudio ajeno se rechaza y la sesion original sigue vigente", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t1 = await esc.sesion(u.id, A());
    const t2 = nuevoToken();
    expect(rechazada(await rotar(t1, t2, B()))).toBe(true);
    expect(await filaSesion(t2)).toBeUndefined();
    expect(await validar(t1)).toHaveLength(1);
  });

  it("un token desconocido o ya revocado no rota", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const nuevo = nuevoToken();
    expect(rechazada(await rotar(nuevoToken(), nuevo, A()))).toBe(true);
    const t1 = await esc.sesion(u.id, A());
    await revocar(t1);
    const nuevo2 = nuevoToken();
    expect(rechazada(await rotar(t1, nuevo2, A()))).toBe(true);
    expect(await filaSesion(nuevo)).toBeUndefined();
    expect(await filaSesion(nuevo2)).toBeUndefined();
  });
});

// =================================================================================================
describe("auth.sesion_revocar, auth.sesiones_cerrar_todas y auth.ultimo_estudio (CA-5, P2, P7)", () => {
  it("sesion_revocar marca la sesion y es idempotente; un token desconocido no falla", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.sesion(u.id, A());
    await revocar(t);
    const primera = (await filaSesion(t)).revocada_en as Date;
    expect(primera).toBeInstanceOf(Date);
    expect((await filaSesion(t)).motivo).toBe("logout");
    await revocar(t);
    expect(((await filaSesion(t)).revocada_en as Date).getTime()).toBe(primera.getTime());
    await revocar(nuevoToken());
  });

  it("sesiones_cerrar_todas revoca todas las del usuario de la sesion (incluida la propia) y ninguna ajena", async () => {
    const u1 = await esc.usuario({ estudios: [A()] });
    const u2 = await esc.usuario({ estudios: [A()] });
    const a1 = await esc.sesion(u1.id, A());
    const a2 = await esc.sesion(u1.id, null);
    const b1 = await esc.sesion(u2.id, A());
    expect(await cerrarTodas(a1)).toBe(2);
    expect(await validar(a1)).toHaveLength(0);
    expect(await validar(a2)).toHaveLength(0);
    expect(await validar(b1)).toHaveLength(1);
    expect((await filaSesion(a2)).motivo).toBe("cerrar_todas");
  });

  it("sesiones_cerrar_todas con un token desconocido devuelve 0 y no toca nada", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.sesion(u.id, A());
    expect(await cerrarTodas(nuevoToken())).toBe(0);
    expect(await validar(t)).toHaveLength(1);
  });

  it("ultimo_estudio devuelve el estudio de la sesion mas reciente con estudio y membresia vigente, aunque este revocada", async () => {
    const u = await esc.usuario({ estudios: [A(), B()] });
    const s1 = await esc.sesion(u.id, A());
    const s2 = await esc.sesion(u.id, B());
    const s3 = await esc.sesion(u.id, null);
    await adm("update auth.sesion set creada_en = now() - interval '2 hours', ultimo_uso = now() - interval '2 hours' where token_hash = $1", [s1]);
    await adm("update auth.sesion set creada_en = now() - interval '1 hour', ultimo_uso = now() - interval '1 hour' where token_hash = $1", [s2]);
    expect(await ultimoEstudio(s3)).toBe(B());
    await revocar(s2);
    expect(await ultimoEstudio(s3)).toBe(B());
    await adm("delete from membresia where tenant_id = $1 and usuario_id = $2", [B(), u.id]);
    expect(await ultimoEstudio(s3)).toBe(A());
  });

  it("ultimo_estudio devuelve NULL sin sesiones con estudio o con un token desconocido", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const solo = await esc.sesion(u.id, null);
    expect(await ultimoEstudio(solo)).toBeNull();
    expect(await ultimoEstudio(nuevoToken())).toBeNull();
  });
});

// =================================================================================================
describe("auth.recuperacion_crear (D8, CA-8)", () => {
  it("con un correo existente guarda solo el hash, vigente 30 min, y devuelve true", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = nuevoToken();
    expect(await crearRecuperacion(u.correo, t)).toBe(true);
    const f = (await adm("select * from auth.token_recuperacion where token_hash = $1", [t]))[0];
    expect(f.usuario_id).toBe(u.id);
    expect(f.usado_en).toBeNull();
    expect(f.invalidado_en).toBeNull();
    const seg = await segundosHasta("expira_en", "auth.token_recuperacion", "token_hash = $1", [t]);
    expect(seg).toBeGreaterThan(1790);
    expect(seg).toBeLessThanOrEqual(1801);
  });

  it("con un correo inexistente (o con otra forma del correo) devuelve false y no guarda nada", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t1 = nuevoToken();
    expect(await crearRecuperacion(esc.correoNuevo(), t1)).toBe(false);
    const t2 = nuevoToken();
    expect(await crearRecuperacion(u.correo.toUpperCase(), t2)).toBe(false);
    for (const t of [t1, t2]) {
      expect(await adm("select 1 from auth.token_recuperacion where token_hash = $1", [t])).toHaveLength(0);
    }
  });

  it("pedir otro invalida el anterior (CA-8)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t1 = nuevoToken();
    const t2 = nuevoToken();
    await crearRecuperacion(u.correo, t1);
    await crearRecuperacion(u.correo, t2);
    const f = (await adm("select invalidado_en from auth.token_recuperacion where token_hash = $1", [t1]))[0];
    expect(f.invalidado_en).not.toBeNull();
    expect(rechazada(await consumir(t1, hashFalso()))).toBe(true);
    const ok = await consumir(t2, hashFalso());
    expect(ok.ok && ok.rows.length).toBe(1);
  });
});

describe("auth.recuperacion_consumir (D8, CA-6, CA-8: un solo uso, atomico)", () => {
  it("fija la contrasena, devuelve usuario y correo, y revoca todas las sesiones (CA-6)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const s1 = await esc.sesion(u.id, A());
    const s2 = await esc.sesion(u.id, null);
    const t = await esc.tokenRecuperacion(u.id);
    const nuevo = hashFalso();
    const r = await exito(consumir(t, nuevo));
    expect(r).toEqual([{ usuario_id: u.id, correo: u.correo }]);
    expect(await hashDe(u.id)).toBe(nuevo);
    for (const s of [s1, s2]) {
      expect(await validar(s)).toHaveLength(0);
      expect((await filaSesion(s)).motivo).toBe("restablecer");
    }
  });

  it("borra el intento_login del correo (reinicia el bloqueo) e invalida los demas tokens", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const k = esc.clave(u.correo);
    for (let i = 0; i < 5; i++) await preparar(u.correo, k);
    expect((await intento(k)).bloqueado_hasta).not.toBeNull();
    const t1 = await esc.tokenRecuperacion(u.id);
    const t2 = await esc.tokenRecuperacion(u.id);
    await exito(consumir(t1, hashFalso()));
    expect(await intento(k)).toBeUndefined();
    expect(rechazada(await consumir(t2, hashFalso()))).toBe(true);
  });

  it("un token solo sirve una vez", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.tokenRecuperacion(u.id);
    const primero = hashFalso();
    await exito(consumir(t, primero));
    expect(rechazada(await consumir(t, hashFalso()))).toBe(true);
    expect(await hashDe(u.id)).toBe(primero);
  });

  it("vencido (expira_en pasada) y desconocido (alterado, truncado) se rechazan igual, sin tocar la contrasena", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.tokenRecuperacion(u.id);
    await adm("update auth.token_recuperacion set expira_en = now() - interval '1 second' where token_hash = $1", [t]);
    const alterado = Buffer.from(t);
    alterado[0] ^= 0xff;
    for (const x of [t, alterado, t.subarray(0, 16), nuevoToken()]) {
      expect(rechazada(await consumir(x, hashFalso())), "debio rechazarse").toBe(true);
    }
    expect(await hashDe(u.id)).toBe(u.hash);
  });

  it("a los 29 min el token aun sirve (limite de 30 min)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.tokenRecuperacion(u.id);
    await adm("update auth.token_recuperacion set creado_en = now() - interval '29 minutes', expira_en = now() + interval '1 minute' where token_hash = $1", [t]);
    expect((await exito(consumir(t, hashFalso()))).length).toBe(1);
  });

  it("dos consumos concurrentes del mismo token: uno solo gana y su contrasena es la que queda", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.tokenRecuperacion(u.id);
    const h1 = hashFalso();
    const h2 = hashFalso();
    const [r1, r2] = await Promise.all([consumir(t, h1), consumir(t, h2)]);
    const gana = (r: typeof r1) => r.ok && r.rows.length === 1;
    expect([gana(r1), gana(r2)].filter(Boolean)).toHaveLength(1);
    expect(await hashDe(u.id)).toBe(gana(r1) ? h1 : h2);
  });

  it("un hash_nuevo invalido falla entero (CHECK) y el token sigue sin usar", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.tokenRecuperacion(u.id);
    const r = await consumir(t, "contrasena-en-claro");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toBe("23514");
    expect(await hashDe(u.id)).toBe(u.hash);
    expect((await exito(consumir(t, hashFalso()))).length).toBe(1);
  });

  it("un usuario sin credencial previa (invitado) tambien queda con contrasena", async () => {
    const u = await esc.usuario({ estudios: [A()], contrasena: false });
    const t = await esc.tokenRecuperacion(u.id);
    const nuevo = hashFalso();
    await exito(consumir(t, nuevo));
    expect(await hashDe(u.id)).toBe(nuevo);
  });
});

describe("auth.contrasena_cambiar (P11, D4)", () => {
  it("fija el hash, rota la sesion actual (misma caducidad), revoca las demas del usuario y devuelve el correo", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const otro = await esc.usuario({ estudios: [A()] });
    const actual = await esc.sesion(u.id, A());
    const otraDelMismo = await esc.sesion(u.id, null);
    const ajena = await esc.sesion(otro.id, A());
    const nuevoToken_ = nuevoToken();
    const nuevo = hashFalso();
    const r = await exito(cambiar(actual, nuevo, nuevoToken_));
    expect(r[0].v).toBe(u.correo);
    expect(await hashDe(u.id)).toBe(nuevo);
    expect(await validar(actual)).toHaveLength(0);
    expect(await validar(otraDelMismo)).toHaveLength(0);
    expect((await filaSesion(otraDelMismo)).motivo).toBe("contrasena");
    expect(await validar(ajena)).toHaveLength(1);
    const v = await validar(nuevoToken_);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ usuario_id: u.id, tenant_activo: A() });
    const cmp = await adm(
      "select (n.expira_absoluta = o.expira_absoluta) as igual from auth.sesion n, auth.sesion o where n.token_hash = $1 and o.token_hash = $2",
      [nuevoToken_, actual],
    );
    expect(cmp[0].igual).toBe(true);
  });

  it("con un token desconocido o revocado no cambia nada", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const t = await esc.sesion(u.id, A());
    await revocar(t);
    for (const x of [t, nuevoToken()]) {
      const nuevo = nuevoToken();
      const r = await cambiar(x, hashFalso(), nuevo);
      expect(r.ok ? r.rows[0]?.v == null : true).toBe(true);
      expect(await filaSesion(nuevo)).toBeUndefined();
    }
    expect(await hashDe(u.id)).toBe(u.hash);
  });
});

// =================================================================================================
describe("withAuth y AuthRepo contra la BD (T9)", () => {
  const dbBackend = () => {
    const d = crearDb("contapp_backend", 3);
    dbs.push(d);
    return d;
  };

  it("withAuth ejecuta las funciones como contapp_backend y confirma al terminar", async () => {
    const auth = conAuth(dbBackend());
    const s = esc.sujeto("login_ip");
    expect(await auth.withAuth((a) => a.limiteConsumir("login_ip", s))).toBe(true);
    const c = await adm("select conteo from auth.limite_tasa where tipo = 'login_ip' and sujeto = $1", [s]);
    expect(c[0].conteo).toBe(1);
  });

  it("withAuth con una BD de rol contapp_worker se rechaza (solo contapp_backend)", async () => {
    const d = crearDb("contapp_worker", 1);
    dbs.push(d);
    let llamada = false;
    await expect(
      conAuth(d).withAuth(async () => {
        llamada = true;
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(llamada).toBe(false);
  });

  it("flujo completo por el repositorio: login, validar, rotar, revocar, recuperar y cambiar contrasena", async () => {
    const auth = conAuth(dbBackend());
    const u = await esc.usuario({ estudios: [A(), B()] });
    const k = esc.clave(u.correo);

    const p = await auth.withAuth((a) => a.loginPreparar(u.correo, k));
    expect(p).toEqual({ permitido: true, usuarioId: u.id, hash: u.hash, alcanzaBloqueo: false });

    const t1 = nuevoToken();
    const ses = await auth.withAuth((a) =>
      a.loginExito({ clave: k, usuarioId: u.id, tokenHash: t1, tenantActivo: A(), hashNuevo: null, tokenAnteriorHash: null }),
    );
    expect(ses.sesionId).toMatch(UUID);
    expect(ses.expiraAbsoluta).toBeInstanceOf(Date);

    const v = await auth.withAuth((a) => a.sesionValidar(t1));
    expect(v).toMatchObject({ sesionId: ses.sesionId, usuarioId: u.id, tenantActivo: A(), estudioRevocado: false });
    expect(await auth.withAuth((a) => a.sesionValidar(nuevoToken()))).toBeNull();

    const t2 = nuevoToken();
    const rot = await auth.withAuth((a) => a.sesionRotar(t1, t2, B()));
    expect(rot.expiraAbsoluta.getTime()).toBe(ses.expiraAbsoluta.getTime());
    expect(await auth.withAuth((a) => a.sesionValidar(t1))).toBeNull();
    expect((await auth.withAuth((a) => a.sesionValidar(t2)))?.tenantActivo).toBe(B());

    const t3 = nuevoToken();
    const nuevoHash = hashFalso();
    expect(await auth.withAuth((a) => a.contrasenaCambiar(t2, nuevoHash, t3))).toBe(u.correo);
    expect(await hashDe(u.id)).toBe(nuevoHash);

    const r1 = nuevoToken();
    expect(await auth.withAuth((a) => a.recuperacionCrear(u.correo, r1))).toBe(true);
    const h2 = hashFalso();
    expect(await auth.withAuth((a) => a.recuperacionConsumir(r1, h2))).toEqual({ usuarioId: u.id, correo: u.correo });
    expect(await auth.withAuth((a) => a.recuperacionConsumir(r1, hashFalso()))).toBeNull();
    expect(await auth.withAuth((a) => a.sesionValidar(t3))).toBeNull();

    const t4 = await esc.sesion(u.id, A());
    expect(await auth.withAuth((a) => a.sesionesCerrarTodas(t4))).toBe(1);
    await auth.withAuth((a) => a.sesionRevocar(t4));
  });

  it("un error de PG sale como AuthRepoError con solo el SQLSTATE (sin detail ni datos de la fila)", async () => {
    const auth = conAuth(dbBackend());
    const AuthRepoError = exportado<new (...a: any[]) => Error & { codigo: string }>("AuthRepoError");
    const u = await esc.usuario({ estudios: [A()] });
    const canario = randomBytes(31);
    const e: any = await auth
      .withAuth((a) =>
        a.loginExito({
          clave: esc.clave(u.correo),
          usuarioId: u.id,
          tokenHash: canario,
          tenantActivo: A(),
          hashNuevo: null,
          tokenAnteriorHash: null,
        }),
      )
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AuthRepoError);
    expect(e.codigo).toBe("23514");
    for (const campo of ["detail", "where", "constraint", "table", "column", "cause"]) {
      expect(e, campo).not.toHaveProperty(campo);
    }
    const volcado = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${inspect(e, { depth: 6, showHidden: true })}`;
    expect(volcado).not.toContain(canario.toString("hex"));
    expect(volcado).not.toContain(u.correo);
  });
});

// =================================================================================================
describe("seed de desarrollo (T9): uSin, contrasena de desarrollo y credenciales", () => {
  const seed = () => exportado<Record<string, any>>("SEED");

  it("SEED expone uSin (UUID) y una contrasena de desarrollo de 12 a 128 caracteres", () => {
    expect(String(seed().uSin)).toMatch(UUID);
    const c = seed().contrasenaDesarrollo;
    expect(typeof c).toBe("string");
    expect([...c].length).toBeGreaterThanOrEqual(12);
    expect([...c].length).toBeLessThanOrEqual(128);
  });

  it("uA, uAB y uSin tienen credencial PHC argon2id en el piso (m=19456, t=2, p=1) y uSin no tiene membresias", async () => {
    const s = seed();
    for (const id of [s.uA, s.uAB, s.uSin]) {
      const r = await adm("select hash from auth.usuario_contrasena where usuario_id = $1", [id]);
      expect(r, `credencial de ${id}`).toHaveLength(1);
      expect(r[0].hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    }
    const n = async (id: string) => Number((await adm("select count(*)::int as n from membresia where usuario_id = $1", [id]))[0].n);
    expect(await n(s.uA)).toBe(1);
    expect(await n(s.uAB)).toBe(2);
    expect(await n(s.uSin)).toBe(0);
    const u = await adm("select email from usuario where id = $1", [s.uSin]);
    expect(u[0].email).toBe(u[0].email.trim().toLowerCase());
  });

  it("el hash de la semilla no guarda la contrasena en claro", async () => {
    const s = seed();
    const r = await adm("select hash from auth.usuario_contrasena where usuario_id = $1", [s.uA]);
    expect(String(r[0].hash)).not.toContain(s.contrasenaDesarrollo);
  });
});

