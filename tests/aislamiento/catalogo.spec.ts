// CA-3 (catalogo): toda tabla con tenant_id tiene RLS ENABLE + FORCE y la politica tenant_isolation.
// Recorre pg_catalog, asi que una tabla nueva sin RLS rompe esta prueba.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirPool, TABLAS_NEGOCIO } from "./soporte";

// auth_definer (spec 004, CA-11) y sus dos hermanas de la spec 005 solo se admiten como las define el plan:
// ver la prueba dedicada abajo. Ajuste de 005 (T2): se agregan auth_definer_insert y auth_definer_update.
const POLITICAS_PERMITIDAS = [
  "tenant_isolation",
  "membresia_por_usuario",
  "auth_definer",
  "auth_definer_insert",
  "auth_definer_update",
];

// Spec 017 (T2, D-13): auditoria, notificacion y plan_aviso tienen tenant_id y RLS forzada, pero NO la politica `tenant_isolation`
// FOR ALL: auditoria solo se lee (FOR SELECT), notificacion se lee y solo cambia `leida_en` (SELECT y UPDATE por usuario) y plan_aviso
// no da acceso a la app. Su detalle (cmd, grants, triggers) lo prueban auditoria-tablas.spec.ts y notificaciones-tablas.spec.ts.
const TABLAS_017 = ["auditoria", "notificacion", "plan_aviso"];

// Spec 028 (T3, R-11, rojo hasta 0073): las cuatro tablas de correo con tenant_id tienen RLS forzada con politicas propias (como las de 017), no
// necesariamente la `tenant_isolation` FOR ALL: nadie de la app las escribe directo (funciones acotadas) y el backend lee las preferencias y los
// envios solo por `usuario_id = app.user_id`. El detalle (grants, escritura directa 42501, filas visibles por rol) lo prueba correo-tablas.spec.ts;
// aqui se exige que toda politica ate a app.tenant_id y que los tokens no tengan politica para la app. `correo_programacion` no tiene tenant_id.
const TABLAS_028 = ["correo_preferencia", "correo_envio", "correo_envio_aviso", "correo_baja_token"];

let pool: Pool;
beforeAll(() => {
  pool = abrirPool();
});
afterAll(async () => {
  await pool.end();
});

async function tablasConTenantId() {
  const r = await pool.query(
    `select c.relname as tabla, c.relrowsecurity as rls, c.relforcerowsecurity as forzada,
            a.attnotnull as no_nula, t.typname as tipo
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
       join pg_type t on t.oid = a.atttypid
      where c.relkind in ('r', 'p')
      order by c.relname`,
  );
  return r.rows as { tabla: string; rls: boolean; forzada: boolean; no_nula: boolean; tipo: string }[];
}

async function politicas() {
  const r = await pool.query(
    `select tablename, policyname, cmd, roles::text[] as roles, qual, with_check
       from pg_policies where schemaname = 'public' order by tablename, policyname`,
  );
  return r.rows as {
    tablename: string;
    policyname: string;
    cmd: string;
    roles: string[];
    qual: string | null;
    with_check: string | null;
  }[];
}

describe("CA-3 catalogo de RLS", () => {
  it("el catalogo incluye las tablas de negocio del esquema base (la prueba no es vacua)", async () => {
    const nombres = (await tablasConTenantId()).map((t) => t.tabla);
    for (const t of TABLAS_NEGOCIO) expect(nombres).toContain(t);
  });

  it("toda tabla con tenant_id tiene RLS ENABLE y FORCE", async () => {
    const tablas = await tablasConTenantId();
    expect(tablas.length).toBeGreaterThan(0);
    const mal = tablas.filter((t) => !t.rls || !t.forzada).map((t) => t.tabla);
    expect(mal, "tablas con tenant_id sin RLS ENABLE+FORCE").toEqual([]);
  });

  it("toda tabla con tenant_id tiene la politica tenant_isolation FOR ALL con USING y WITH CHECK sobre app.tenant_id", async () => {
    const tablas = await tablasConTenantId();
    expect(tablas.length).toBeGreaterThan(0);
    const pols = await politicas();
    const sin: string[] = [];
    for (const t of tablas) {
      if (TABLAS_017.includes(t.tabla) || TABLAS_028.includes(t.tabla)) continue; // politicas propias de 017 y de 028 (ver arriba)
      const p = pols.find((x) => x.tablename === t.tabla && x.policyname === "tenant_isolation");
      // Ajuste de 006 (T1, plan "BD"): `suscripcion` es la unica con tenant_isolation FOR SELECT (sin WITH CHECK): el
      // estudio la lee pero ninguna escritura pasa por RLS aunque alguien le concediera UPDATE al backend (CA-1).
      if (t.tabla === "suscripcion") {
        if (!p || p.cmd !== "SELECT" || !p.qual?.includes("app.tenant_id") || p.with_check !== null) sin.push(t.tabla);
        continue;
      }
      if (!p || p.cmd !== "ALL" || !p.qual?.includes("app.tenant_id") || !p.with_check?.includes("app.tenant_id")) {
        sin.push(t.tabla);
      }
    }
    expect(sin, "tablas sin tenant_isolation correcta").toEqual([]);
  });

  it("solo existen las politicas permitidas y membresia_por_usuario es solo SELECT en membresia", async () => {
    const pols = await politicas();
    expect(pols.length).toBeGreaterThan(0);
    // Ajuste de 008 (T3, plan "BD"): job_registro admite ademas UNA politica FOR DELETE (la del worker, solo estados
    // terminales); su nombre lo elige T7. El detalle (rol, filas que alcanza) lo comprueba trabajos.spec.ts.
    const raras = pols.filter(
      (p) =>
        !POLITICAS_PERMITIDAS.includes(p.policyname) &&
        !(p.tablename === "job_registro" && p.cmd === "DELETE") &&
        // Ajuste de 028 (T17, 0075, H-028-1-3): RESTRICTIVE de INSERT para contapp_backend sin `notificacion.enviar` (detalle en trabajos.spec.ts).
        !(p.tablename === "job_registro" && p.cmd === "INSERT" && p.policyname === "job_registro_sin_correo_backend") &&
        !TABLAS_017.includes(p.tablename) &&
        !TABLAS_028.includes(p.tablename),
    );
    expect(raras.map((p) => `${p.tablename}.${p.policyname}`)).toEqual([]);
    for (const p of pols.filter((x) => x.policyname === "membresia_por_usuario")) {
      expect(p.tablename).toBe("membresia");
      expect(p.cmd).toBe("SELECT");
    }
    expect(pols.some((p) => p.tablename === "membresia" && p.policyname === "membresia_por_usuario")).toBe(true);
  });

  // Ajuste de 005 (T2, plan "BD"): las politicas de contapp_auth son exactamente estas. SELECT en usuario, membresia e
  // invitacion; INSERT (solo para crear la cuenta y la membresia al aceptar una invitacion) en usuario y membresia;
  // UPDATE (marcar la invitacion como aceptada) en invitacion. Ninguna otra, ni DELETE.
  // HUECO DEL PLAN (informado en T2): invitacion_vigente y aceptar_existente devuelven el nombre del estudio, y
  // contapp_auth no lee `tenant`. Si T7 lo resuelve con una lectura de `tenant` para contapp_auth, es SOLO esta politica
  // (auth_definer, SELECT, USING (true)) y se admite aqui y en auth.spec.ts; cualquier otra tabla extra falla.
  it("politicas de contapp_auth (004 + 005): auth_definer SELECT en usuario, membresia e invitacion (y, opcional, tenant), USING (true), solo para contapp_auth", async () => {
    const pols = (await politicas()).filter((p) => p.policyname === "auth_definer");
    // Ajuste de 006 (T1): `suscripcion` tambien lleva auth_definer SELECT (contapp_auth la lee en las funciones de cupo).
    // Ajuste de 028 (T3): `auth.correo_baja_aplicar` (dueño contapp_auth) lee `correo_baja_token`; si T10 lo resuelve con una politica `auth_definer`
    // SELECT para contapp_auth, es SOLO esta y solo para ese rol (la prueba de TABLAS_028 de abajo exige que no sea de escritura).
    expect(pols.map((p) => p.tablename).filter((t) => t !== "tenant" && t !== "suscripcion" && t !== "correo_baja_token").sort()).toEqual([
      "invitacion",
      "membresia",
      "usuario",
    ]);
    for (const p of pols) {
      expect(p.cmd).toBe("SELECT");
      expect(p.roles).toEqual(["contapp_auth"]);
      expect(p.qual).toBe("true");
    }
  });

  // Ajuste de 006 (T1, plan "BD"): registro_confirmar_* crean el estudio y su suscripcion, asi que auth_definer_insert
  // tambien existe en `tenant` y en `suscripcion` (y solo ahi, ademas de usuario y membresia).
  it("auth_definer_insert (005 + 006) existe solo en usuario, membresia, tenant y suscripcion: INSERT, WITH CHECK (true), solo para contapp_auth", async () => {
    const pols = (await politicas()).filter((p) => p.policyname === "auth_definer_insert");
    expect(pols.map((p) => p.tablename).sort()).toEqual(["membresia", "suscripcion", "tenant", "usuario"]);
    for (const p of pols) {
      expect(p.cmd).toBe("INSERT");
      expect(p.roles).toEqual(["contapp_auth"]);
      expect(p.with_check).toBe("true");
    }
  });

  // Ajuste de 006 (T1): suscripcion_asignar actualiza la suscripcion, asi que auth_definer_update tambien existe ahi.
  it("auth_definer_update (005 + 006) existe solo en invitacion y suscripcion: UPDATE, solo para contapp_auth", async () => {
    const pols = (await politicas()).filter((p) => p.policyname === "auth_definer_update");
    expect(pols.map((p) => p.tablename).sort()).toEqual(["invitacion", "suscripcion"]);
    for (const p of pols) {
      expect(p.cmd).toBe("UPDATE");
      expect(p.roles).toEqual(["contapp_auth"]);
    }
  });

  it("ninguna politica de contapp_auth cubre DELETE ni ALL, y asignacion no tiene politicas para contapp_auth", async () => {
    const pols = (await politicas()).filter((p) => p.roles.includes("contapp_auth"));
    expect(pols.filter((p) => p.cmd === "DELETE" || p.cmd === "ALL")).toEqual([]);
    expect(pols.filter((p) => p.tablename === "asignacion")).toEqual([]);
  });

  it("asignacion e invitacion (005) estan en el catalogo de tablas con tenant_id (la prueba no es vacua)", async () => {
    const nombres = (await tablasConTenantId()).map((t) => t.tabla);
    expect(nombres).toContain("asignacion");
    expect(nombres).toContain("invitacion");
  });

  // Ajuste de 008 (T3, CA-15): job_registro (tabla nueva con tenant_id) entra al catalogo; config_sistema NO (sin tenant_id).
  it("job_registro (008) esta en el catalogo de tablas con tenant_id y config_sistema no (la prueba no es vacua)", async () => {
    const nombres = (await tablasConTenantId()).map((t) => t.tabla);
    expect(nombres).toContain("job_registro");
    expect(nombres).not.toContain("config_sistema");
  });

  // Spec 006 (T1, CA-1, CA-8, plan "BD"): suscripcion es de estudio (tenant_id, RLS); plan y admin_plataforma son de
  // plataforma y NO tienen tenant_id (los lee el backend solo por columnas permitidas; ver planes.spec.ts).
  it("suscripcion (006) esta en el catalogo de tablas con tenant_id; plan y admin_plataforma no (la prueba no es vacua)", async () => {
    const nombres = (await tablasConTenantId()).map((t) => t.tabla);
    expect(nombres).toContain("suscripcion");
    expect(nombres).not.toContain("plan");
    expect(nombres).not.toContain("admin_plataforma");
  });

  // Spec 017 (T2, D-13, rojo hasta 0041/0043): las tres tablas nuevas entran al catalogo con RLS ENABLE y FORCE.
  it("auditoria, notificacion y plan_aviso (017) estan en el catalogo de tablas con tenant_id, con RLS ENABLE y FORCE", async () => {
    const tablas = await tablasConTenantId();
    for (const t of TABLAS_017) {
      const fila = tablas.find((x) => x.tabla === t);
      expect(fila, `${t} en el catalogo`).toBeDefined();
      expect({ rls: fila!.rls, forzada: fila!.forzada }, t).toEqual({ rls: true, forzada: true });
    }
  });

  // Spec 024 (T2, D-5, CA-10, rojo hasta la migracion 0059): el historial de atencion del buzon entra al catalogo con tenant_id
  // uuid NOT NULL, RLS ENABLE + FORCE y la politica tenant_isolation FOR ALL (las pruebas anteriores la recorren sola); no es de plataforma.
  it("buzon_atencion (024) esta en el catalogo de tablas con tenant_id, con RLS ENABLE y FORCE y tenant_isolation FOR ALL", async () => {
    const fila = (await tablasConTenantId()).find((x) => x.tabla === "buzon_atencion");
    expect(fila, "buzon_atencion en el catalogo").toBeDefined();
    expect({ rls: fila!.rls, forzada: fila!.forzada, no_nula: fila!.no_nula, tipo: fila!.tipo }, "buzon_atencion").toEqual({
      rls: true,
      forzada: true,
      no_nula: true,
      tipo: "uuid",
    });
    const p = (await politicas()).find((x) => x.tablename === "buzon_atencion" && x.policyname === "tenant_isolation");
    expect(p?.cmd).toBe("ALL");
    expect(p?.qual).toContain("app.tenant_id");
    expect(p?.with_check).toContain("app.tenant_id");
  });

  // Spec 030 (T6, D1, CA-9): los roles propios y sus permisos entran al catalogo con tenant_id uuid NOT NULL, RLS ENABLE + FORCE y una sola
  // politica, tenant_isolation FOR ALL (las pruebas anteriores las recorren solas); rol_permiso se ata al estudio por la FK compuesta.
  for (const tabla of ["rol", "rol_permiso"]) {
    it(`${tabla} (030) esta en el catalogo de tablas con tenant_id, con RLS ENABLE y FORCE y solo tenant_isolation FOR ALL`, async () => {
      const fila = (await tablasConTenantId()).find((x) => x.tabla === tabla);
      expect(fila, `${tabla} en el catalogo`).toBeDefined();
      expect({ rls: fila!.rls, forzada: fila!.forzada, no_nula: fila!.no_nula, tipo: fila!.tipo }, tabla).toEqual({
        rls: true,
        forzada: true,
        no_nula: true,
        tipo: "uuid",
      });
      const ps = (await politicas()).filter((x) => x.tablename === tabla);
      expect(ps.map((p) => [p.policyname, p.cmd])).toEqual([["tenant_isolation", "ALL"]]);
      expect(ps[0]?.qual).toContain("app.tenant_id");
      expect(ps[0]?.with_check).toContain("app.tenant_id");
    });
  }

  // Spec 025 (T3, D-4, CA-7, rojo hasta la migracion 0061): las importaciones y las candidatas del aprendizaje de arranque entran al
  // catalogo con tenant_id uuid NOT NULL, RLS ENABLE + FORCE y tenant_isolation FOR ALL (las pruebas anteriores las recorren solas).
  for (const tabla of ["regla_importacion", "regla_candidata"]) {
    it(`${tabla} (025) esta en el catalogo de tablas con tenant_id, con RLS ENABLE y FORCE y tenant_isolation FOR ALL`, async () => {
      const fila = (await tablasConTenantId()).find((x) => x.tabla === tabla);
      expect(fila, `${tabla} en el catalogo`).toBeDefined();
      expect({ rls: fila!.rls, forzada: fila!.forzada, no_nula: fila!.no_nula, tipo: fila!.tipo }, tabla).toEqual({
        rls: true,
        forzada: true,
        no_nula: true,
        tipo: "uuid",
      });
      const p = (await politicas()).find((x) => x.tablename === tabla && x.policyname === "tenant_isolation");
      expect(p?.cmd).toBe("ALL");
      expect(p?.qual).toContain("app.tenant_id");
      expect(p?.with_check).toContain("app.tenant_id");
    });
  }

  // Spec 026 (T3, D-4, CA-8, rojo hasta la migracion 0065): las cuatro tablas de la prorrata (obtenciones, declaraciones mensuales,
  // meses manuales y prorrata usada ingresada) entran al catalogo con tenant_id uuid NOT NULL, RLS ENABLE + FORCE y tenant_isolation
  // FOR ALL (las pruebas anteriores las recorren solas).
  for (const tabla of ["prorrata_obtencion", "declaracion_mensual", "prorrata_mes_manual", "prorrata_usada_manual"]) {
    it(`${tabla} (026) esta en el catalogo de tablas con tenant_id, con RLS ENABLE y FORCE y tenant_isolation FOR ALL`, async () => {
      const fila = (await tablasConTenantId()).find((x) => x.tabla === tabla);
      expect(fila, `${tabla} en el catalogo`).toBeDefined();
      expect({ rls: fila!.rls, forzada: fila!.forzada, no_nula: fila!.no_nula, tipo: fila!.tipo }, tabla).toEqual({
        rls: true,
        forzada: true,
        no_nula: true,
        tipo: "uuid",
      });
      const p = (await politicas()).find((x) => x.tablename === tabla && x.policyname === "tenant_isolation");
      expect(p?.cmd).toBe("ALL");
      expect(p?.qual).toContain("app.tenant_id");
      expect(p?.with_check).toContain("app.tenant_id");
    });
  }

  // Spec 027 (T3, D-2, R-6, CA-7, rojo hasta la migracion 0069): las cinco tablas del estudio de gastos no deducibles (palabras propias,
  // globales desactivadas, umbral, categorias por cliente y cache de CIIU) entran al catalogo con tenant_id uuid NOT NULL, RLS ENABLE +
  // FORCE y tenant_isolation FOR ALL (las pruebas anteriores las recorren solas).
  for (const tabla of [
    "gnd_palabra_estudio",
    "gnd_global_desactivada",
    "gnd_config",
    "gnd_cliente_categorias",
    "gnd_ciiu",
  ]) {
    it(`${tabla} (027) esta en el catalogo de tablas con tenant_id, con RLS ENABLE y FORCE y tenant_isolation FOR ALL`, async () => {
      const fila = (await tablasConTenantId()).find((x) => x.tabla === tabla);
      expect(fila, `${tabla} en el catalogo`).toBeDefined();
      expect({ rls: fila!.rls, forzada: fila!.forzada, no_nula: fila!.no_nula, tipo: fila!.tipo }, tabla).toEqual({
        rls: true,
        forzada: true,
        no_nula: true,
        tipo: "uuid",
      });
      const p = (await politicas()).find((x) => x.tablename === tabla && x.policyname === "tenant_isolation");
      expect(p?.cmd).toBe("ALL");
      expect(p?.qual).toContain("app.tenant_id");
      expect(p?.with_check).toContain("app.tenant_id");
    });
  }

  // Spec 027 (T3, D-2): el diccionario global y su historial son de plataforma (como `plan`): NO tienen tenant_id ni politica de estudio;
  // los lee el backend y el worker y solo contapp_auth (funciones `auth.gnd_global_*`) los escribe (grants: gnd-tablas.spec.ts).
  it("gnd_palabra_global y gnd_global_historial (027) existen, son de plataforma y no tienen tenant_id (la prueba no es vacua)", async () => {
    const r = await pool.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind in ('r','p') and c.relname in ('gnd_palabra_global', 'gnd_global_historial')`,
    );
    expect(r.rows.map((x) => x.relname).sort(), "faltan tablas (migracion 0069)").toEqual([
      "gnd_global_historial",
      "gnd_palabra_global",
    ]);
    const con = (await tablasConTenantId()).map((t) => t.tabla);
    expect(con).not.toContain("gnd_palabra_global");
    expect(con).not.toContain("gnd_global_historial");
    const pols = (await politicas()).filter((p) => p.tablename === "gnd_palabra_global" || p.tablename === "gnd_global_historial");
    expect(pols.map((p) => `${p.tablename}.${p.policyname}`)).toEqual([]);
  });

  // Spec 028 (T3, R-11, rojo hasta la migracion 0073): las cuatro tablas del estudio de correo entran al catalogo con tenant_id uuid NOT NULL y
  // RLS ENABLE + FORCE; correo_programacion es de plataforma (sin tenant_id, RLS ENABLE sin politicas) y existe.
  it.each(TABLAS_028)("%s (028) esta en el catalogo de tablas con tenant_id, con RLS ENABLE y FORCE", async (tabla) => {
    const fila = (await tablasConTenantId()).find((x) => x.tabla === tabla);
    expect(fila, `${tabla} en el catalogo`).toBeDefined();
    expect({ rls: fila!.rls, forzada: fila!.forzada, no_nula: fila!.no_nula, tipo: fila!.tipo }, tabla).toEqual({
      rls: true,
      forzada: true,
      no_nula: true,
      tipo: "uuid",
    });
  });

  it("las politicas de las tablas de correo (028) siempre atan a app.tenant_id; el backend lee solo las preferencias propias (app.user_id) y la app no tiene politica sobre los tokens", async () => {
    const pols = (await politicas()).filter((p) => TABLAS_028.includes(p.tablename));
    const de = (t: string) => pols.filter((p) => p.tablename === t);
    for (const t of ["correo_preferencia", "correo_envio", "correo_envio_aviso"]) {
      expect(de(t).length, `${t}: falta su politica (migracion 0073)`).toBeGreaterThan(0);
      for (const p of de(t)) expect(p.qual, `${t}.${p.policyname}`).toContain("app.tenant_id");
    }
    expect(de("correo_preferencia").some((p) => p.qual?.includes("app.user_id")), "el backend lee solo las suyas (app.user_id)").toBe(true);
    expect(de("correo_envio").some((p) => p.qual?.includes("app.user_id")), "el backend lee solo sus envios (app.user_id)").toBe(true);
    // los tokens no los lee la app aunque alguien le concediera SELECT: ninguna politica para backend, worker, contapp_app, plataforma ni PUBLIC
    for (const p of de("correo_baja_token")) {
      expect(p.roles.every((r) => ["contapp_auth", "contapp_migrator", "contapp_registrador"].includes(r)), `correo_baja_token.${p.policyname} para ${p.roles.join()}`).toBe(true);
    }
  });

  it("correo_programacion (028) existe, es de plataforma: sin tenant_id, RLS ENABLE y sin politicas", async () => {
    const r = await pool.query(
      `select c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relname = 'correo_programacion' and c.relkind in ('r', 'p')`,
    );
    expect(r.rows, "falta correo_programacion (migracion 0073)").toEqual([{ rls: true }]);
    expect((await tablasConTenantId()).map((t) => t.tabla)).not.toContain("correo_programacion");
    expect((await politicas()).filter((p) => p.tablename === "correo_programacion")).toEqual([]);
  });

  it("tenant_id es uuid NOT NULL en toda tabla de negocio", async () => {
    const tablas = await tablasConTenantId();
    expect(tablas.length).toBeGreaterThan(0);
    const mal = tablas.filter((t) => t.tipo !== "uuid" || !t.no_nula).map((t) => t.tabla);
    expect(mal).toEqual([]);
  });

  it("las tablas de plataforma (tenant, usuario) existen y no tienen tenant_id", async () => {
    const r = await pool.query(
      `select c.relname
         from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind in ('r','p') and c.relname in ('tenant', 'usuario')`,
    );
    expect(r.rows.map((x) => x.relname).sort()).toEqual(["tenant", "usuario"]);
    const con = (await tablasConTenantId()).map((t) => t.tabla);
    expect(con).not.toContain("tenant");
    expect(con).not.toContain("usuario");
  });

  it("toda tabla de public pertenece a contapp_migrator", async () => {
    const r = await pool.query(
      `select c.relname as tabla, o.rolname as dueno
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         join pg_roles o on o.oid = c.relowner
        where c.relkind in ('r', 'p')
        order by c.relname`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(4);
    const ajenas = r.rows.filter((x) => x.dueno !== "contapp_migrator").map((x) => `${x.tabla}:${x.dueno}`);
    expect(ajenas).toEqual([]);
  });
});

// Spec 029 (T1, CA-7, rojo hasta 0078): las tres tablas nuevas del esquema `auth` son de la cuenta, no del estudio: sin `tenant_id`, con RLS
// forzada, una sola politica `auth_definer` para contapp_auth (ninguna `tenant_isolation` ni politica para un rol de la app) y dueño
// contapp_migrator. El detalle de grants y columnas esta en auth-totp-tablas.spec.ts.
describe("029 · tablas de la cuenta segura en el esquema auth", () => {
  const TABLAS_029 = ["totp", "totp_recuperacion", "cuenta_evento"];

  it("existen, no tienen tenant_id, tienen RLS ENABLE+FORCE y dueño contapp_migrator", async () => {
    const r = await pool.query(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forzada, o.rolname as dueno,
              exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as con_tenant
         from pg_class c join pg_roles o on o.oid = c.relowner
        where c.relnamespace = to_regnamespace('auth') and c.relname = any($1::text[]) order by c.relname`,
      [TABLAS_029],
    );
    expect(r.rows.map((x) => x.relname)).toEqual([...TABLAS_029].sort());
    for (const t of r.rows) expect(t, t.relname).toMatchObject({ rls: true, forzada: true, dueno: "contapp_migrator", con_tenant: false });
  });

  it("solo tienen la politica auth_definer FOR ALL de contapp_auth: ninguna para los roles de la app", async () => {
    const r = await pool.query(
      `select tablename, policyname, cmd, roles::text[] as roles from pg_policies where schemaname = 'auth' and tablename = any($1::text[]) order by 1, 2`,
      [TABLAS_029],
    );
    expect(r.rows).toEqual([...TABLAS_029].sort().map((tablename) => ({ tablename, policyname: "auth_definer", cmd: "ALL", roles: ["contapp_auth"] })));
  });
});
