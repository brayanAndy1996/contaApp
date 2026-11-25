// Spec 028 (T3, rojo): baja sin sesion y purga a 90 dias en BD real (R-7, R-10, R-11, U-12, D-4; CA-8). `correo_baja_token_crear` guarda solo el
// hash del token de cada correo; `auth.correo_baja_aplicar` apaga SOLO el tipo de su (estudio, usuario), audita con origen `enlace`, es
// idempotente y no distingue un token valido de uno invalido, vencido o ajeno; `correo_purgar` borra a los 90 dias con las notificaciones.
// Falla hoy porque las migraciones 0073-0074 aun no existen. El contrato esta en la cabecera de correo-soporte.ts.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentar, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  abrirApp,
  crearDb,
  DIA_MS,
  EscenarioCorreo,
  llamar,
  tokenNuevo,
} from "./correo-soporte";

let admin: Pool;
let app: Pool;
let ec: EscenarioCorreo;
let worker: ContappDb;
let X: string;
let Y: string;
let uA: string; // contador de X y de Y
let uB: string; // contador de X

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirApp(6);
  ec = new EscenarioCorreo(admin);
  X = await ec.estudioPlan();
  Y = await ec.estudioPlan();
  uA = (await ec.et.ea.cuenta()).id;
  await ec.et.ea.membresia(X, uA, "contador");
  await ec.et.ea.membresia(Y, uA, "contador");
  uB = (await ec.et.miembro(X, "contador")).id;
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await worker?.close().catch(() => undefined);
  await app?.end();
  await admin?.end();
});

const rechazo = (r: { ok: boolean; code?: string }, code: string) => {
  expect(r.ok, "la sentencia debia fallar").toBe(false);
  if (!r.ok) expect((r as { code: string }).code).toBe(code);
};
const ms = (d: Date | string): number => new Date(d).getTime();
const enTenant = <T>(tenant: string, fn: (q: (sql: string, v?: unknown[]) => Promise<any[]>) => Promise<T>) =>
  worker.withTenant({ tenantId: tenant }, (tx) => fn(async (sql, v) => (await tx.query(sql, v)).rows));
const baja = (hash: Buffer | null, rol?: string) => llamar(app, "select auth.correo_baja_aplicar($1::bytea)", [hash], rol);
const hoyLima = async () => (await ec.hoyLima()).dia;
const filaToken = async (hash: Buffer) => (await admin.query("select * from correo_baja_token where hash = $1", [hash])).rows[0];
const tiposApagados = async (tenant: string, usuario: string): Promise<string[]> =>
  (await Promise.all(["buzon_critico", "credencial_invalida", "plan_limite", "resumen"].map(async (t) => [t, await ec.efectiva(tenant, usuario, t)] as const)))
    .filter(([, v]) => !v)
    .map(([t]) => t);

/** Envio pendiente del tipo para el usuario (por `interno.notificar` o `crear_correo_resumenes`) y su token de baja creado por la funcion del worker. */
async function conToken(tenant: string, usuario: string, tipo: string): Promise<{ hash: Buffer; token: Buffer; envioId: string }> {
  if (tipo === "resumen") {
    await ec.preferencia(tenant, usuario, "resumen", true);
    const dia = await hoyLima();
    await enTenant(tenant, (q) => q("select crear_correo_resumenes($1::date)", [dia]));
  } else {
    await ec.notificarDirecto(admin, tenant, [usuario], tipo);
  }
  const [e] = await ec.envios(tenant, { usuarioId: usuario, tipo });
  const { token, hash } = tokenNuevo();
  await enTenant(tenant, (q) => q("select correo_baja_token_crear($1::uuid, $2::bytea)", [e!.id, hash]));
  return { hash, token, envioId: e!.id };
}

describe("correo_baja_token_crear: guarda solo el hash, ligado al (estudio, usuario, tipo) del envio, vigente 90 dias (R-7, R-11)", () => {
  it.each(["buzon_critico", "credencial_invalida", "resumen"])("token del tipo %s", async (tipo) => {
    const u = (await ec.et.miembro(X, "contador")).id;
    const antes = Date.now();
    const { token, hash, envioId } = await conToken(X, u, tipo);
    const f = await filaToken(hash);
    expect(f).toMatchObject({ tenant_id: X, usuario_id: u, tipo, envio_id: envioId });
    expect(Buffer.compare(f.hash, hash)).toBe(0);
    expect(Buffer.compare(f.hash, token), "nunca el token en claro").not.toBe(0);
    expect(ms(f.vence_en) - ms(f.creado_en)).toBeGreaterThan(90 * DIA_MS - 60_000);
    expect(ms(f.vence_en) - ms(f.creado_en)).toBeLessThan(90 * DIA_MS + 60_000);
    expect(Math.abs(ms(f.creado_en) - antes)).toBeLessThan(10_000);
  });

  it("en un envio de pendientes el token es del tipo diferido; un hash que no mide 32 bytes: 22023; envio ajeno: P0002", async () => {
    const u = (await ec.et.miembro(X, "contador")).id;
    await ec.notificarDirecto(admin, X, [u], "credencial_invalida");
    const [e] = await ec.envios(X, { usuarioId: u });
    for (const hash of [null, Buffer.alloc(0), Buffer.alloc(31, 7), Buffer.alloc(33, 7)]) {
      rechazo(await intentar(worker, { tenantId: X }, "select correo_baja_token_crear($1::uuid, $2::bytea)", [e!.id, hash]), "22023");
    }
    rechazo(await intentar(worker, { tenantId: Y }, "select correo_baja_token_crear($1::uuid, $2::bytea)", [e!.id, tokenNuevo().hash]), "P0002");
    rechazo(
      await intentar(worker, { tenantId: X }, "select correo_baja_token_crear('00000000-0000-4000-8000-000000000000'::uuid, $1::bytea)", [tokenNuevo().hash]),
      "P0002",
    );
    expect((await admin.query("select count(*)::int as n from correo_baja_token where envio_id = $1", [e!.id])).rows[0].n).toBe(0);
  });
});

describe("auth.correo_baja_aplicar: apaga solo su tipo, audita con origen enlace, idempotente (CA-8)", () => {
  it("apaga SOLO el tipo del token del usuario y estudio del token: ni los otros tipos, ni otro usuario, ni el mismo usuario en otro estudio", async () => {
    const t = await conToken(X, uA, "buzon_critico");
    await ec.notificarDirecto(admin, Y, [uA], "buzon_critico"); // el mismo usuario en Y tiene su propio estado
    const aparte = (await ec.et.miembro(X, "contador")).id;
    expect(await tiposApagados(X, uA)).toEqual(["plan_limite", "resumen"]); // iniciales de un Contador
    const r = await baja(t.hash);
    expect(r.ok).toBe(true);
    expect(await tiposApagados(X, uA)).toEqual(["buzon_critico", "plan_limite", "resumen"]);
    expect(await ec.efectiva(X, uA, "credencial_invalida")).toBe(true);
    expect(await tiposApagados(Y, uA), "otro estudio").toEqual(["plan_limite", "resumen"]);
    expect(await tiposApagados(X, aparte), "otro usuario").toEqual(["plan_limite", "resumen"]);
    const audit = await ec.auditoriaPreferencia(X, uA);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ accion: "correo.preferencia_cambiada", actor_tipo: "usuario", usuario_id: uA, tenant_id: X, trabajo_id: null });
    expect(audit[0].datos).toEqual({ tipo: "buzon_critico", de: true, a: false, origen: "enlace" });
    expect(await ec.auditoriaPreferencia(Y, uA)).toEqual([]);
  });

  it("repetirlo da lo mismo: sin error, sin otra fila de auditoria y la preferencia sigue apagada (nunca activa)", async () => {
    const u = (await ec.et.miembro(X, "contador")).id;
    const tb = await conToken(X, u, "buzon_critico");
    const tc = await conToken(X, u, "credencial_invalida");
    await ec.preferencia(X, u, "buzon_critico", false); // ya apagada desde la app
    const primera = await baja(tc.hash);
    const segunda = await baja(tc.hash);
    expect(segunda).toEqual(primera);
    expect(await ec.efectiva(X, u, "credencial_invalida")).toBe(false);
    expect(await ec.auditoriaPreferencia(X, u)).toHaveLength(1);
    // el token de un tipo que ya estaba apagado: ni error, ni cambio, ni auditoria
    expect((await baja(tb.hash)).ok).toBe(true);
    expect(await ec.efectiva(X, u, "buzon_critico")).toBe(false);
    expect(await ec.auditoriaPreferencia(X, u)).toHaveLength(1);
  });

  it("el token del resumen apaga el resumen (con audit tipo resumen) y no toca los avisos", async () => {
    const u = (await ec.et.miembro(X, "contador")).id;
    const t = await conToken(X, u, "resumen");
    expect(await ec.efectiva(X, u, "resumen")).toBe(true);
    await baja(t.hash);
    expect(await ec.efectiva(X, u, "resumen")).toBe(false);
    expect(await ec.efectiva(X, u, "buzon_critico")).toBe(true);
    expect((await ec.auditoriaPreferencia(X, u)).map((a) => a.datos)).toEqual([{ tipo: "resumen", de: true, a: false, origen: "enlace" }]);
  });

  it("un token valido, uno inexistente, uno alterado, uno vencido, el token en claro, nulo, vacio o de otra longitud responden exactamente igual y los invalidos no cambian nada", async () => {
    const u = (await ec.et.miembro(X, "contador")).id;
    const valido = await conToken(X, u, "buzon_critico");
    const vencido = await conToken(X, u, "credencial_invalida");
    await admin.query("update correo_baja_token set vence_en = now() - interval '1 second' where hash = $1", [vencido.hash]);
    const alterado = Buffer.from(valido.hash);
    alterado[0] = alterado[0]! ^ 0x01;
    const invalidos: [string, Buffer | null][] = [
      ["inexistente", tokenNuevo().hash],
      ["alterado", alterado],
      ["vencido", vencido.hash],
      ["token en claro, no su hash", valido.token],
      ["nulo", null],
      ["vacio", Buffer.alloc(0)],
      ["31 bytes", randomBytes(31)],
      ["64 bytes", randomBytes(64)],
    ];
    const respuestas: unknown[] = [];
    for (const [nombre, h] of invalidos) {
      const r = await baja(h);
      expect(r.ok, nombre).toBe(true);
      respuestas.push(r);
    }
    expect(await tiposApagados(X, u), "ningun token invalido cambia algo").toEqual(["plan_limite", "resumen"]);
    expect(await ec.auditoriaPreferencia(X, u)).toEqual([]);
    const buena = await baja(valido.hash);
    for (const r of respuestas) expect(r).toEqual(buena); // mismo codigo y cuerpo que el exito
    expect(await tiposApagados(X, u)).toEqual(["buzon_critico", "plan_limite", "resumen"]);
  });

  it("el token de un usuario no sirve para otro: aplicar el del usuario B deja a A como estaba", async () => {
    const a = await conToken(X, uA, "credencial_invalida");
    const b = await conToken(X, uB, "credencial_invalida");
    const antesA = await tiposApagados(X, uA);
    await baja(b.hash);
    expect(await tiposApagados(X, uA)).toEqual(antesA);
    expect(await ec.efectiva(X, uB, "credencial_invalida")).toBe(false);
    expect(a.envioId).not.toBe(b.envioId);
  });

  it("solo contapp_backend la ejecuta: el worker, la app y la plataforma reciben 42501", async () => {
    const { hash } = tokenNuevo();
    for (const rol of ["contapp_worker", "contapp_app", "contapp_platform"]) {
      const r = await baja(hash, rol);
      rechazo(r, "42501");
    }
  });
});

describe("purga a 90 dias (R-11, P-7): envios, avisos y tokens junto con las notificaciones", () => {
  const purgar = (tenant: string, dias = 90) =>
    enTenant(tenant, async (q) => Number((await q("select correo_purgar($1::int) as n", [dias]))[0].n));
  const hay = async (sql: string, v: unknown[]) => (await admin.query(sql, v)).rows[0].n as number;

  async function usuarioConEnvio(t: string, tipo = "buzon_critico") {
    const u = (await ec.et.miembro(t, "contador")).id;
    const tok = await conToken(t, u, tipo);
    return { u, ...tok };
  }

  it("borra los envios de mas de 90 dias del estudio con sus avisos y tokens y deja los de 89; devuelve cuantos envios borro", async () => {
    const t = await ec.estudioPlan();
    const otro = await ec.estudioPlan();
    const viejo = await usuarioConEnvio(t);
    const justo = await usuarioConEnvio(t);
    const nuevo = await usuarioConEnvio(t);
    const ajeno = await usuarioConEnvio(otro);
    await ec.envejecerCorreo(t, 91, viejo.u);
    await ec.envejecerCorreo(t, 89, justo.u);
    await ec.envejecerCorreo(otro, 200, ajeno.u);
    expect(await purgar(t)).toBe(1);
    const cuenta = (tabla: string, col: string, id: string) => hay(`select count(*)::int as n from ${tabla} where ${col} = $1`, [id]);
    expect(await cuenta("correo_envio", "id", viejo.envioId)).toBe(0);
    expect(await cuenta("correo_envio_aviso", "envio_id", viejo.envioId)).toBe(0);
    expect(await cuenta("correo_baja_token", "envio_id", viejo.envioId)).toBe(0);
    for (const x of [justo, nuevo]) {
      expect(await cuenta("correo_envio", "id", x.envioId)).toBe(1);
      expect(await cuenta("correo_envio_aviso", "envio_id", x.envioId)).toBe(1);
      expect(await cuenta("correo_baja_token", "envio_id", x.envioId)).toBe(1);
    }
    expect(await cuenta("correo_envio", "id", ajeno.envioId), "el otro estudio queda intacto").toBe(1);
    expect(await purgar(t), "repetir").toBe(0);
    expect(await purgar(t, 30)).toBe(1); // con 30 dias cae tambien el de 89
  });

  it("borra tambien los avisos diferidos (sin envio) y los tokens viejos; solo con p_dias >= 1", async () => {
    const t = await ec.estudioPlan();
    const u = (await ec.et.miembro(t, "contador")).id;
    await ec.sembrarEnviados(t, u, 30);
    await ec.notificarDirecto(admin, t, [u], "buzon_critico"); // diferido por el tope
    expect(await ec.diferidosDe(t, u)).toHaveLength(1);
    await ec.envejecerCorreo(t, 120, u);
    const n = await purgar(t);
    expect(n).toBe(30);
    expect(await ec.diferidosDe(t, u)).toEqual([]);
    for (const dias of [0, -1]) {
      rechazo(await intentar(worker, { tenantId: t }, "select correo_purgar($1::int)", [dias]), "22023");
    }
    rechazo(await intentar(worker, { tenantId: t }, "select correo_purgar(null)"), "22023");
  });

  it("notificacion_purgar nunca falla por un aviso de correo: el aviso sigue a su notificacion aunque sea mas nuevo (el orden de la purga no importa)", async () => {
    const t = await ec.estudioPlan();
    const u = (await ec.et.miembro(t, "contador")).id;
    await ec.notificarDirecto(admin, t, [u], "buzon_critico");
    expect(await ec.avisosDe(t, { usuarioId: u })).toHaveLength(1);
    await ec.envejecer(t, 91 * 24); // la notificacion cumple 91 dias; el aviso, 89
    await ec.envejecerCorreo(t, 89, u);
    const borradas = await enTenant(t, async (q) => Number((await q("select notificacion_purgar(90) as n"))[0].n));
    expect(borradas).toBe(1);
    expect(await ec.notifs(t, { usuarioId: u })).toEqual([]);
    expect(await ec.avisosDe(t, { usuarioId: u }), "el aviso se va con su notificacion").toEqual([]);
  });

  it("purgar en el orden del worker (correo y luego notificaciones) deja todo limpio", async () => {
    const t = await ec.estudioPlan();
    const x = await usuarioConEnvio(t);
    await ec.envejecer(t, 95 * 24);
    await ec.envejecerCorreo(t, 95, x.u);
    expect(await purgar(t)).toBe(1);
    const n = await enTenant(t, async (q) => Number((await q("select notificacion_purgar(90) as n"))[0].n));
    expect(n).toBe(1);
    expect(await ec.envios(t)).toEqual([]);
    expect(await ec.avisosDe(t)).toEqual([]);
  });
});
