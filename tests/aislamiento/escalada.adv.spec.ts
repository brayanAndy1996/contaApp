// Ronda adversarial 1 (T8, spec 002): escalada de privilegios desde la conexion de DATABASE_URL
// (rol de login y roles de la app), DDL contra RLS, GUC peligrosos y SECURITY DEFINER.
// Solo DATABASE_URL. Todo se ejecuta en transacciones que se revierten.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirPool,
  crearDb,
  enRollback,
  filasRaw,
  intentar,
  intentarRaw,
  semilla,
  tenantDe,
  type ContappDb,
  type Intento,
  type Tx,
} from "./soporte";
import type { Pool } from "pg";
import { FUNCIONES_AUTH, FUNCIONES_SISTEMA } from "./auth-soporte";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Ejecuta el CLI `migrar` ya compilado (como `pnpm db:migrate`); devuelve stdout+stderr. */
function correrMigrar(): Promise<string> {
  const script = fileURLToPath(
    new URL("../../packages/db/dist/cli/migrar.js", import.meta.url),
  );
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script],
      { env: process.env, timeout: 50_000 },
      (err, stdout, stderr) => {
        const salida = `${stdout}${stderr}`;
        if (err) reject(new Error(`migrar fallo (codigo ${String(err.code)})`));
        else resolve(salida);
      },
    );
  });
}

async function capturar(
  tx: Tx,
  text: string,
  values: unknown[] = [],
): Promise<Intento> {
  try {
    const r = await tx.query(text, values);
    return { ok: true, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      ok: false,
      code: String(err.code ?? ""),
      message: String(err.message ?? ""),
    };
  }
}

const FIRMA_ENCOLAR_XML = "encolar_xml_obtener(uuid,text,uuid[],uuid)";
const FIRMA_BLOQUEAR_REEVALUAR = "bloquear_compras_reevaluar(uuid[])";

// Spec 017 (T7, migraciones 0041-0043): SECURITY DEFINER admitidas, por firma (regprocedure) y dueño esperado. Todas con
// search_path = pg_catalog, pg_temp y sin EXECUTE para PUBLIC (se verifica abajo, una por una).
const REGISTRADOR = "contapp_registrador";
const MIGRATOR = "contapp_migrator";
// Spec 025 (T3): firma (regprocedure) y unico rol de la app con EXECUTE de cada funcion de la migracion 0062.
const FUNCIONES_025: { firma: string; ejecuta: string }[] = [
  { firma: "reglas_importacion_iniciar(uuid,character[])", ejecuta: "contapp_backend" },
  { firma: "reglas_importacion_trabajo(uuid,uuid)", ejecuta: "contapp_backend" },
  { firma: "reglas_importacion_completar(uuid,jsonb,jsonb)", ejecuta: "contapp_worker" },
  { firma: "reglas_importacion_fallar(uuid,text)", ejecuta: "contapp_worker" },
  { firma: "reglas_candidatas_activar(uuid,jsonb,uuid)", ejecuta: "contapp_backend" },
  { firma: "reglas_candidata_reemplazar(uuid,uuid,text,integer)", ejecuta: "contapp_backend" },
  { firma: "reglas_candidatas_descartar(uuid,uuid[])", ejecuta: "contapp_backend" },
];
const FUNCIONES_017: { firma: string; dueno: string }[] = [
  ...[
    "sesion", "invitacion", "membresia", "asignacion", "cliente", "credencial", "propuesta", "compra_operacion", "venta", "xml",
    "periodo", "archivo",
  ].map((n) => ({ firma: `auditoria_capturar_${n}()`, dueno: MIGRATOR })),
  { firma: "auditoria_registrar(uuid,text,uuid,text,uuid,jsonb,uuid)", dueno: MIGRATOR },
  { firma: "auditoria_descifrado_listar(timestamp with time zone,uuid,integer)", dueno: MIGRATOR },
  { firma: "interno.auditoria_insertar(uuid,text,uuid,uuid,text,uuid,text,uuid,jsonb)", dueno: REGISTRADOR },
  { firma: "interno.membresia_via(uuid,uuid,text)", dueno: MIGRATOR },
  { firma: "interno.notificar(uuid,uuid[],text,uuid,uuid,jsonb,text)", dueno: REGISTRADOR },
  { firma: "interno.uso_plan(uuid)", dueno: MIGRATOR },
  { firma: "notificacion_credencial_invalida()", dueno: MIGRATOR },
  { firma: "notificacion_trabajo_terminado()", dueno: MIGRATOR },
  { firma: "notificacion_purgar(integer)", dueno: REGISTRADOR },
  // Spec 021 (T9, migraciones 0047-0049): R-HIS en la descarga, aceptación al revisar y auditoría de reglas. 0050 (T18) y 0051
  // (T21) reemplazan aplicar_regla_historial y regla_aceptar_periodo con la misma firma, dueño y grants.
  { firma: "aplicar_regla_historial(uuid,uuid,jsonb)", dueno: MIGRATOR },
  { firma: "reglas_historial_vigentes(uuid,text)", dueno: MIGRATOR },
  { firma: "regla_aceptar_periodo()", dueno: MIGRATOR },
  ...["regla", "regla_motor", "aporte", "regla_aplicacion"].map((n) => ({ firma: `auditoria_capturar_${n}()`, dueno: MIGRATOR })),
  // Spec 021 (T25c, migracion 0052): R-HIS por lotes (EXECUTE solo contapp_worker) y el INSERT de auditoria por lote de la
  // captura compra.historial por sentencia (dueño contapp_registrador, EXECUTE solo contapp_migrator).
  { firma: "aplicar_reglas_historial(jsonb)", dueno: MIGRATOR },
  { firma: "interno.auditoria_insertar_lote(uuid,text,uuid,uuid,text,text,uuid[],uuid[],jsonb[])", dueno: REGISTRADOR },
  { firma: "notificaciones_de_esta_transaccion()", dueno: REGISTRADOR },
  { firma: "plan_aviso_disparar()", dueno: MIGRATOR },
  { firma: "plan_aviso_recalcular(uuid)", dueno: REGISTRADOR },
  // Spec 023 (T11, migraciones 0054-0056): candado del ciclo y estudios vigentes del programador del buzón (sistema.*, EXECUTE solo
  // contapp_worker), candidatos y encolado programado (worker), elevación de prioridad, bloqueo del estado y auditoría (backend),
  // destinatarios del aviso (interno, sin EXECUTE para la app) y los triggers de aviso y de auditoría del contenido.
  // T21 (migración 0058, revisadas): sistema.buzon_ciclo_tomar (H-023-2-7) y buzon_mensaje_aviso_obligatorio (H-023-2-9) se
  // reemplazan con el mismo dueño, search_path fijo y los mismos EXECUTE; no hay funciones nuevas.
  ...["buzon_ciclo_tomar(text)", "buzon_ciclo_renovar(text)", "buzon_ciclo_soltar(text)", "estudios_buzon()"].map((f) => ({
    firma: `sistema.${f}`,
    dueno: MIGRATOR,
  })),
  { firma: "buzon_candidatos()", dueno: MIGRATOR },
  { firma: "encolar_buzon_programados(uuid[])", dueno: MIGRATOR },
  { firma: "buzon_elevar_prioridad(uuid)", dueno: MIGRATOR },
  { firma: "buzon_estado_bloquear(uuid)", dueno: MIGRATOR },
  { firma: "buzon_auditar(text,uuid,uuid,uuid)", dueno: MIGRATOR },
  { firma: "buzon_mensaje_aviso_obligatorio()", dueno: MIGRATOR },
  { firma: "buzon_mensaje_aviso()", dueno: MIGRATOR },
  { firma: "auditoria_capturar_buzon_contenido()", dueno: MIGRATOR },
  { firma: "interno.destinatarios_cliente(uuid,uuid)", dueno: MIGRATOR },
  // Spec 024 (T2, rojo hasta las migraciones 0059-0060 de T7): la función acotada de la atención del buzón (EXECUTE solo
  // contapp_backend) y el trigger que fija histórico y deja en blanco el estado de atención al insertar (D-5, D-12).
  { firma: "buzon_atencion_aplicar(uuid,uuid[],text,text)", dueno: MIGRATOR },
  { firma: "buzon_mensaje_atencion_inicial()", dueno: MIGRATOR },
  // Spec 025 (T3, rojo hasta la migracion 0062): las funciones acotadas de importaciones y candidatas (plan 025, Contratos: BD). Las del
  // backend (iniciar, trabajo, activar, reemplazar, descartar) y las del worker (completar, fallar) se verifican abajo, una por una.
  // El plan habla de «seis funciones»; el contrato de BD enumera siete y las siete entran aqui.
  ...FUNCIONES_025.map((f) => ({ firma: f.firma, dueno: MIGRATOR })),
];
const nombre017 = (f: string) => (f.includes(".") && f.indexOf(".") < f.indexOf("(") ? f : `public.${f}`).replace(/\(.*$/, "");

describe("ADV escalada desde DATABASE_URL", () => {
  let pool: Pool;
  let backend: ContappDb;
  let worker: ContappDb;
  let superusuario: string;
  beforeAll(async () => {
    pool = abrirPool(2);
    backend = crearDb("contapp_backend");
    worker = crearDb("contapp_worker");
    const r = await pool.query(
      `select rolname from pg_roles where rolsuper order by oid limit 1`,
    );
    superusuario = r.rows[0].rolname as string;
  });
  afterAll(async () => {
    await backend?.close();
    await worker?.close();
    await pool?.end();
  });
  const ctxA = () => ({ tenantId: tenantDe("A") });

  it("desde un rol de app (dentro de withTenant) no se llega a migrator ni al superusuario; RESET ROLE no da acceso", async () => {
    const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const intentos = [
      await intentar(backend, ctxA(), `set role contapp_migrator`),
      await intentar(backend, ctxA(), `set role ${ident(superusuario)}`),
      await intentar(
        backend,
        ctxA(),
        `set session authorization ${ident(superusuario)}`,
      ),
      await intentar(
        backend,
        ctxA(),
        `set session authorization contapp_migrator`,
      ),
    ];
    for (const r of intentos) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    }
    const tras = await enRollback(backend, ctxA(), async (tx) => {
      await tx.query(`reset role`);
      return {
        quien: (await tx.query(`select current_user as u`)).rows[0].u as string,
        lectura: await capturar(tx, `select id from cliente`),
      };
    });
    expect(tras.quien).toBe("contapp_app");
    expect(tras.lectura.ok).toBe(false);
  });

  it("desde un rol de app no se puede cambiar a otro rol (platform/backend) para ganar privilegios ajenos", async () => {
    // backend -> platform: escribir usuarios de cualquier estudio (p. ej. cambiar el email de uB).
    const aPlatform = await enRollback(backend, ctxA(), async (tx) => {
      const set = await capturar(tx, `set local role contapp_platform`);
      const escritura = set.ok
        ? await capturar(
            tx,
            `update usuario set nombre = nombre where id = $1`,
            [semilla().uB],
          )
        : set;
      return { set, escritura };
    });
    // worker -> backend: leer usuario, que worker no tiene concedido.
    const aBackend = await enRollback(worker, ctxA(), async (tx) => {
      const set = await capturar(tx, `set local role contapp_backend`);
      const lectura = set.ok
        ? await capturar(tx, `select id from usuario`)
        : set;
      return { set, lectura };
    });
    // D8: contapp_platform queda fuera del alcance del login de la app.
    expect(aPlatform.set.ok).toBe(false);
    if (!aPlatform.set.ok) expect(aPlatform.set.code).toBe("42501");
    expect(aPlatform.escritura.ok).toBe(false);
    // RIESGO ACEPTADO (D8): el worker puede pasar a contapp_backend (y leer usuario con su RLS).
    // Se fija el comportamiento conocido; si cambia, la prueba falla y obliga a revisar D8.
    expect(aBackend.set).toEqual({ ok: true, rowCount: 0 });
    expect(aBackend.lectura.ok).toBe(true);
  });

  it("ningun rol de la conexion puede desactivar RLS, tocar politicas ni crear objetos que la esquiven", async () => {
    const ddl = [
      `alter table cliente disable row level security`,
      `alter table cliente no force row level security`,
      `alter policy tenant_isolation on cliente using (true)`,
      `drop policy tenant_isolation on cliente`,
      `create policy abierta on cliente for select using (true)`,
      `alter table cliente owner to contapp_backend`,
      // GRANT sin privilegio de concesion no falla (solo WARNING "no privileges were granted"):
      // solo cuenta como exito si el privilegio quedo realmente concedido.
      `do $$ begin execute 'grant select on cliente to contapp_app';
         if not has_table_privilege('contapp_app', 'public.cliente', 'select') then raise exception 'sin efecto'; end if;
         end $$`,
      `create function public.f_adv() returns setof cliente language sql security definer as 'select * from cliente'`,
      `create view public.v_adv as select * from cliente`,
      `create temp table t_adv (x int)`,
      `create schema s_adv`,
      `create extension if not exists dblink`,
    ];
    // D8: contapp_platform ya no es alcanzable desde el login (se comprueba aparte), asi que el
    // DDL se intenta solo con los roles a los que la conexion de DATABASE_URL si puede pasar.
    const roles = [null, "contapp_backend", "contapp_worker"];
    const exitos: string[] = [];
    for (const rol of roles) {
      for (const sql of ddl) {
        const r = await intentarRaw(pool, rol, sql);
        if (r.ok) exitos.push(`${rol ?? "contapp_app"}: ${sql}`);
      }
    }
    expect(exitos).toEqual([]);
    const aPlatform = await intentarRaw(
      pool,
      null,
      `set local role contapp_platform`,
    );
    expect(aPlatform.ok).toBe(false);
    if (!aPlatform.ok) expect(aPlatform.code).toBe("42501");
  });

  it("row_security = off falla cerrado y session_replication_role (salta FK/triggers) es rechazado", async () => {
    const rs = await enRollback(backend, ctxA(), async (tx) => {
      await tx.query(`set local row_security = off`);
      return capturar(tx, `select id from cliente`);
    });
    expect(rs.ok).toBe(false);
    if (!rs.ok) expect(rs.code).toBe("42501");
    const srr = await intentar(
      backend,
      ctxA(),
      `set local session_replication_role = replica`,
    );
    expect(srr.ok).toBe(false);
  });

  // H7, D10 (opcion A): limite conocido de PostgreSQL 17 (todo rol LOGIN puede fijar sus propios
  // valores por defecto de sesion con ALTER ROLE self [IN DATABASE d] SET). No se exige que el ataque
  // falle: se comprueba que `migrar` (el CLI real, unico lector de MIGRATIONS_DATABASE_URL, CA-2b)
  // restaura la configuracion de contapp_app. El ataque se persiste con valores que solo afectan a
  // conexiones nuevas y `migrar` se ejecuta siempre (finally) para limpiarlo. La contrasena
  // (PASSWORD NULL) no se ataca aqui: dejaria sin login a la suite si la reparacion fallara.
  it("H7 (D10): tras persistir valores por defecto de sesion en contapp_app, migrar los restaura", async () => {
    const leerAjustes = `select s.setdatabase::int as setdatabase, s.setconfig
        from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
       where r.rolname = 'contapp_app' order by 1`;
    const esperado = [{ setdatabase: 0, setconfig: ["lc_messages=C"] }];
    const sondear = async (sql: string): Promise<true | string> => {
      try {
        await pool.query(sql);
        return true;
      } catch (e) {
        return String((e as { code?: string }).code ?? "");
      }
    };
    let antes: unknown[] = [];
    const resultados: (true | string)[] = [];
    let salida = "";
    try {
      // Nombre de la base citado en el servidor (%I), no interpolado en el cliente.
      const enBase = (
        await pool.query(
          `select format('alter role contapp_app in database %I set work_mem = %L', current_database(), '64kB') as s`,
        )
      ).rows[0].s as string;
      resultados.push(
        await sondear(`alter role contapp_app set app.tenant_id = '${tenantDe("B")}'`),
        await sondear(`alter role contapp_app set row_security = off`),
        await sondear(enBase),
      );
      antes = await filasRaw(pool, null, leerAjustes);
    } finally {
      salida = await correrMigrar();
    }
    // Comportamiento conocido: PG rechaza el GUC propio app.tenant_id (placeholder sin privilegio
    // SET), pero acepta los parametros USERSET, tambien IN DATABASE (limite de PG). Si cambia, revisar D10.
    expect(resultados).toEqual(["42501", true, true]);
    expect(JSON.stringify(antes)).toContain("row_security=off");
    expect(JSON.stringify(antes)).toContain("work_mem=64kB");
    // migrar repara y solo informa estados fijos, sin secretos.
    expect(salida).toContain("migrar: ajustes de contapp_app reparados");
    expect(salida).toContain("migrar: OK");
    const pw = decodeURIComponent(new URL(String(process.env.DATABASE_URL)).password);
    expect(pw.length > 0 && salida.includes(pw)).toBe(false);
    // Estado restaurado: solo el ajuste esperado y una conexion nueva arranca sin los valores del ataque.
    expect(await filasRaw(pool, null, leerAjustes)).toEqual(esperado);
    const nuevo = abrirPool(1);
    try {
      const r = await nuevo.query(
        `select current_setting('row_security') as rs, current_setting('work_mem') as wm`,
      );
      expect(r.rows[0].rs).toBe("on");
      expect(r.rows[0].wm).not.toBe("64kB");
    } finally {
      await nuevo.end();
    }
  }, 60_000);

  it("no existen funciones SECURITY DEFINER ni vistas sin security_invoker fuera de los esquemas del sistema", async () => {
    const defs = await filasRaw(
      pool,
      null,
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')`,
    );
    const defsPublic = (
      await filasRaw(
        pool,
        null,
        `select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.prosecdef and n.nspname = 'public'`,
      )
    ).map((d) => d.f);
    const props017 = await filasRaw(
      pool,
      null,
      `select f.firma, pg_get_userbyid(p.proowner) as dueno, p.prosecdef, p.proconfig as config,
              has_function_privilege('public', p.oid, 'EXECUTE') as publico
         from unnest(array[${FUNCIONES_017.map((f) => `'${f.firma}'`).join(", ")}]::text[]) as f(firma)
         left join pg_proc p on p.oid::regprocedure::text = f.firma
        order by f.firma`,
    );
    const encolarXml = await filasRaw(
      pool,
      null,
      `select pg_get_userbyid(p.proowner) as dueno, p.proconfig as config,
              has_function_privilege('public', p.oid, 'EXECUTE') as publico,
              coalesce((select array_agg(r.rolname::text order by r.rolname) from pg_roles r
                         where r.oid <> p.proowner and r.rolname like 'contapp\\_%' and has_function_privilege(r.oid, p.oid, 'EXECUTE')), '{}'::text[]) as ejecutan
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('encolar_xml_obtener', 'bloquear_compras_reevaluar')
        order by p.proname`,
    );
    const vistas = await filasRaw(
      pool,
      null,
      `select n.nspname || '.' || c.relname as v from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('v', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
          and not coalesce('security_invoker=true' = any(c.reloptions), false)`,
    );
    const uuid = await filasRaw(
      pool,
      null,
      `select p.prosecdef, pg_get_userbyid(p.proowner) as dueno from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'uuid_v7'`,
    );
    // Spec 004 (D10) y 005 (D7): las unicas SECURITY DEFINER admitidas son las de FUNCIONES_AUTH (15) del esquema `auth`.
    // Ajuste de 008 (T3, D18): FUNCIONES_AUTH pasa a 16 (auth.purgar) y se admiten las dos del esquema `sistema`
    // (devuelven solo UUID; dueño contapp_enumerador; EXECUTE solo contapp_worker).
    // Ajuste de 016 (T12b, migracion 0037; decision del usuario 2026-11-10): se admite exactamente
    // public.encolar_xml_obtener(uuid, text, uuid[], uuid) y nada mas en `public`.
    // Ajuste de 017 (T7, migraciones 0041-0043): se admiten las 24 de FUNCIONES_017 (captura de auditoria, registro y lectura de
    // auditoria, notificaciones y aviso del plan); contapp_migrator o contapp_registrador como dueño.
    // Ajuste de 016 (T23, migracion 0038, H-016-8): se admite ademas public.bloquear_compras_reevaluar(uuid[]) (solo bloquea
    // compras vivas del estudio; mismo dueño, search_path fijo y EXECUTE solo contapp_worker).
    // Ajuste de 023 (T11, migraciones 0054-0056): se admiten las 13 del buzón (en FUNCIONES_017, dueño contapp_migrator); las
    // cuatro de `sistema` las devuelve la lista general y no la de `public`.
    expect(defs.map((d) => d.f).sort()).toEqual(
      [
        ...FUNCIONES_AUTH.map((n) => `auth.${n}`),
        ...FUNCIONES_SISTEMA.map((n) => `sistema.${n}`),
        "public.bloquear_compras_reevaluar",
        "public.encolar_xml_obtener",
        ...FUNCIONES_017.map((f) => nombre017(f.firma)),
      ].sort(),
    );
    expect([...defsPublic].sort()).toEqual(
      [FIRMA_BLOQUEAR_REEVALUAR, FIRMA_ENCOLAR_XML, ...FUNCIONES_017.filter((f) => !/^(interno|sistema)\./.test(f.firma)).map((f) => f.firma)].sort(),
    );
    // Cada SECURITY DEFINER de 017: existe, dueño esperado, search_path fijo, sin EXECUTE para PUBLIC.
    // El orden de la consulta depende de la colación de la BD (CI y local difieren con `_`): se ordena aquí igual que lo esperado.
    expect([...props017].sort((a, b) => (a.firma < b.firma ? -1 : 1))).toEqual(
      [...FUNCIONES_017]
        .sort((a, b) => (a.firma < b.firma ? -1 : 1))
        .map((f) => ({
          firma: f.firma,
          dueno: f.dueno,
          prosecdef: true,
          config: ["search_path=pg_catalog, pg_temp"],
          publico: false,
        })),
    );
    expect(encolarXml).toEqual([
      {
        dueno: "contapp_migrator",
        config: ["search_path=pg_catalog, pg_temp"],
        publico: false,
        ejecutan: ["contapp_worker"],
      },
      {
        dueno: "contapp_migrator",
        config: ["search_path=pg_catalog, pg_temp"],
        publico: false,
        ejecutan: ["contapp_worker"],
      },
    ]);
    expect(vistas).toEqual([]);
    expect(uuid).toEqual([{ prosecdef: false, dueno: "contapp_migrator" }]);
  });

  // Spec 025 (T3, CA-7, rojo hasta 0062): cada funcion de importaciones y candidatas la ejecuta solo el rol del plan (ni PUBLIC ni otro
  // rol de la app, el dueño aparte), es SECURITY DEFINER de contapp_migrator y fija su search_path.
  it("las funciones de importaciones y candidatas (025): dueno contapp_migrator, search_path fijo, sin EXECUTE para PUBLIC y solo el rol del plan", async () => {
    const r = await filasRaw(
      pool,
      null,
      `select f.firma, pg_get_userbyid(p.proowner) as dueno, p.prosecdef, p.proconfig as config,
              has_function_privilege('public', p.oid, 'EXECUTE') as publico,
              coalesce((select array_agg(x.rolname::text order by x.rolname) from pg_roles x
                         where x.oid <> p.proowner and x.rolname like 'contapp\\_%' and has_function_privilege(x.oid, p.oid, 'EXECUTE')), '{}'::text[]) as ejecutan
         from unnest(array[${FUNCIONES_025.map((f) => `'${f.firma}'`).join(", ")}]::text[]) as f(firma)
         left join pg_proc p on p.oid::regprocedure::text = f.firma
        order by f.firma`,
    );
    expect(r).toEqual(
      [...FUNCIONES_025]
        .sort((a, b) => (a.firma < b.firma ? -1 : 1))
        .map((f) => ({
          firma: f.firma,
          dueno: "contapp_migrator",
          prosecdef: true,
          config: ["search_path=pg_catalog, pg_temp"],
          publico: false,
          ejecutan: [f.ejecuta],
        })),
    );
  });
});
