// Spec 008 (T11b, rojo) · D22: `auth.sesion_consultar(token_hash)` valida la sesión igual que `auth.sesion_validar`
// (0013) pero SIN escribir: no renueva `ultimo_uso` ni limpia `tenant_activo`. La usan `GET /trabajos/stream` y su
// revalidación para que el stream no cuente como actividad (2 h de inactividad de 004 D3).
//
// Contrato fijado (T11c, migración 0019_sesion_consultar.sql):
//   auth.sesion_consultar(token_hash bytea)
//     -> (sesion_id, usuario_id, tenant_activo, estudio_revocado, expira_absoluta)   -- mismas columnas, tipos y filas
//   STABLE, SECURITY DEFINER, dueño contapp_auth, search_path = pg_catalog, pg_temp, EXECUTE solo contapp_backend.
// Rojo: la función aún no existe (SQLSTATE 42883).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Escenario,
  abrirAdmin,
  abrirApp,
  exito,
  llamar,
  nuevoToken,
} from "./auth-soporte";
import { tenantDe } from "./soporte";

let app: Pool;
let admin: Pool;
let esc: Escenario;

beforeAll(() => {
  app = abrirApp(10);
  admin = abrirAdmin(4);
  esc = new Escenario(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});

const A = () => tenantDe("A");
const B = () => tenantDe("B");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLUMNAS = [
  "sesion_id",
  "usuario_id",
  "tenant_activo",
  "estudio_revocado",
  "expira_absoluta",
];

const adm = async (sql: string, v: unknown[] = []) =>
  (await admin.query(sql, v)).rows;
const SEL_CONSULTAR = "select * from auth.sesion_consultar($1::bytea)";
const SEL_VALIDAR = "select * from auth.sesion_validar($1::bytea)";
const consultar = (t: Buffer) => exito(llamar(app, SEL_CONSULTAR, [t]));
const validar = (t: Buffer) => exito(llamar(app, SEL_VALIDAR, [t]));
const filaSesion = async (t: Buffer) =>
  (await adm("select * from auth.sesion where token_hash = $1", [t]))[0];
const mover = (t: Buffer, set: string) =>
  adm(`update auth.sesion set ${set} where token_hash = $1`, [t]);

/** Sesión con `ultimo_uso` de hace 10 min (> 5 min: `sesion_validar` SÍ la renovaría). */
async function sesionAntigua(estudios: string[], activo: string | null) {
  const u = await esc.usuario({ estudios });
  const t = await esc.sesion(u.id, activo);
  await mover(t, "ultimo_uso = now() - interval '10 minutes'");
  return { u, t };
}

describe("auth.sesion_consultar (D22): misma validación y salida que auth.sesion_validar", () => {
  it("sesión vigente: una fila con las mismas columnas y valores que sesion_validar", async () => {
    const { u, t } = await sesionAntigua([A()], A());
    const c = await consultar(t);
    expect(c).toHaveLength(1);
    expect(Object.keys(c[0]!)).toEqual(COLUMNAS);
    expect(c[0]).toMatchObject({
      usuario_id: u.id,
      tenant_activo: A(),
      estudio_revocado: false,
    });
    expect(c[0].sesion_id).toMatch(UUID);
    expect(c[0].expira_absoluta).toBeInstanceOf(Date);
    expect(c).toEqual(await validar(t));
  });

  it("sesión sin estudio activo: tenant_activo NULL y estudio_revocado false, igual que sesion_validar", async () => {
    const { t } = await sesionAntigua([A()], null);
    const c = await consultar(t);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      tenant_activo: null,
      estudio_revocado: false,
    });
    expect(c).toEqual(await validar(t));
  });

  it("revocada: cero filas (como sesion_validar)", async () => {
    const { t } = await sesionAntigua([A()], A());
    await mover(t, "revocada_en = now()");
    expect(await consultar(t)).toHaveLength(0);
    expect(await validar(t)).toHaveLength(0);
  });

  it("2 h de inactividad: a los 119 min una fila; a los 121 min cero (como sesion_validar)", async () => {
    const { t } = await sesionAntigua([A()], A());
    await mover(t, "ultimo_uso = now() - interval '119 minutes'");
    expect(await consultar(t)).toHaveLength(1);
    await mover(t, "ultimo_uso = now() - interval '121 minutes'");
    expect(await consultar(t)).toHaveLength(0);
    expect(await validar(t)).toHaveLength(0);
  });

  it("vencida absoluta (> 12 h): cero filas aunque haya actividad reciente (como sesion_validar)", async () => {
    const { t } = await sesionAntigua([A()], A());
    await mover(
      t,
      "ultimo_uso = now(), expira_absoluta = now() - interval '1 second'",
    );
    expect(await consultar(t)).toHaveLength(0);
    expect(await validar(t)).toHaveLength(0);
  });

  it("token inexistente: cero filas", async () => {
    expect(await consultar(nuevoToken())).toHaveLength(0);
  });

  it("estudio sin membresía: devuelve tenant_activo NULL y estudio_revocado true, igual que sesion_validar", async () => {
    const u = await esc.usuario({ estudios: [A(), B()] });
    const t = await esc.sesion(u.id, B());
    await adm(
      "delete from membresia where tenant_id = $1 and usuario_id = $2",
      [B(), u.id],
    );
    const c = await consultar(t);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      usuario_id: u.id,
      tenant_activo: null,
      estudio_revocado: true,
    });
    expect(c).toEqual(await validar(t));
  });

  it("estudio con la membresía desactivada: estudio_revocado true", async () => {
    const u = await esc.usuario({ estudios: [A(), B()] });
    const t = await esc.sesion(u.id, B());
    await adm(
      "update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2",
      [B(), u.id],
    );
    const c = await consultar(t);
    expect(c[0]).toMatchObject({ tenant_activo: null, estudio_revocado: true });
  });
});

describe("auth.sesion_consultar (D22): no escribe nada", () => {
  it("vigente con ultimo_uso de hace 10 min: la fila de auth.sesion queda idéntica (ultimo_uso, tenant_activo)", async () => {
    const { t } = await sesionAntigua([A()], A());
    const antes = await filaSesion(t);
    expect((await consultar(t))[0]).toMatchObject({ tenant_activo: A() });
    const despues = await filaSesion(t);
    expect(despues.ultimo_uso.getTime()).toBe(antes.ultimo_uso.getTime());
    expect(despues).toEqual(antes);
    // Control: sesion_validar sí la renueva, así la igualdad anterior no es vacía.
    await validar(t);
    expect((await filaSesion(t)).ultimo_uso.getTime()).toBeGreaterThan(
      antes.ultimo_uso.getTime(),
    );
  });

  it("estudio sin membresía: informa estudio_revocado pero NO limpia tenant_activo (sesion_validar sí)", async () => {
    const u = await esc.usuario({ estudios: [A(), B()] });
    const t = await esc.sesion(u.id, B());
    await adm(
      "delete from membresia where tenant_id = $1 and usuario_id = $2",
      [B(), u.id],
    );
    const antes = await filaSesion(t);
    await consultar(t);
    await consultar(t);
    const despues = await filaSesion(t);
    expect(despues.tenant_activo).toBe(B());
    expect(despues).toEqual(antes);
    await validar(t);
    expect((await filaSesion(t)).tenant_activo).toBeNull();
  });

  it("vencida por inactividad, revocada o inexistente: no cambia nada ni crea filas", async () => {
    const { t } = await sesionAntigua([A()], A());
    await mover(t, "ultimo_uso = now() - interval '3 hours'");
    const antes = await filaSesion(t);
    const [{ n: filasAntes }] = await adm(
      "select count(*)::int as n from auth.sesion",
    );
    await consultar(t);
    await consultar(nuevoToken());
    expect(await filaSesion(t)).toEqual(antes);
    const [{ n: filasDespues }] = await adm(
      "select count(*)::int as n from auth.sesion",
    );
    expect(filasDespues).toBe(filasAntes);
  });
});

describe("auth.sesion_consultar (D22): atributos y privilegios (como las demás funciones de auth)", () => {
  const catalogo = async () =>
    adm(
      `select p.prosecdef, p.provolatile, o.rolname as dueno, p.proconfig,
              pg_get_function_identity_arguments(p.oid) as args,
              has_function_privilege('contapp_backend', p.oid, 'EXECUTE') as backend,
              has_function_privilege('contapp_worker', p.oid, 'EXECUTE') as worker,
              has_function_privilege('contapp_platform', p.oid, 'EXECUTE') as platform,
              has_function_privilege('contapp_app', p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as publico
         from pg_proc p join pg_roles o on o.oid = p.proowner
        where p.pronamespace = to_regnamespace('auth') and p.proname = 'sesion_consultar'`,
    );

  it("existe una sola firma (bytea), SECURITY DEFINER, STABLE, dueño contapp_auth y search_path fijo", async () => {
    const r = await catalogo();
    expect(r, "auth.sesion_consultar no existe (0019 pendiente)").toHaveLength(
      1,
    );
    expect(r[0].args).toBe("p_token_hash bytea");
    expect(r[0].prosecdef).toBe(true);
    expect(r[0].provolatile).toBe("s"); // STABLE
    expect(r[0].dueno).toBe("contapp_auth");
    const sp = (r[0].proconfig as string[] | null)?.find((x) =>
      x.startsWith("search_path="),
    );
    expect(sp).toMatch(/^search_path=pg_catalog,\s*pg_temp$/);
  });

  it("EXECUTE solo para contapp_backend: ni el worker, ni platform, ni contapp_app, ni PUBLIC", async () => {
    const r = await catalogo();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      backend: true,
      worker: false,
      platform: false,
      app: false,
      publico: false,
    });
  });

  it.each(["contapp_worker", "contapp_platform", "contapp_app"])(
    "%s no puede llamarla (42501)",
    async (rol) => {
      const r = await llamar(admin, SEL_CONSULTAR, [nuevoToken()], rol);
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.code).toBe("42501");
    },
  );

  it("contapp_backend la ejecuta sin error", async () => {
    const r = await llamar(
      app,
      SEL_CONSULTAR,
      [nuevoToken()],
      "contapp_backend",
    );
    expect(r.ok, r.ok ? "" : `SQLSTATE ${r.code}`).toBe(true);
  });
});
