// Spec 030 (T1, rojo hasta 0082) · CA-3, CA-9, D3, U7, U10: inventario CERRADO de las funciones de la BD que deciden por `rol` y clases de cada
// una (resolvedor / explicita U10 / sin cambio). Lee pg_proc.prosrc: una funcion nueva que mencione `rol` y no este en la lista falla aqui, de modo que
// nadie la olvide (plan.md, Riesgos). T6 mantiene esta lista junto con `catalogo.spec.ts`.
// Rojo por: el esquema `acceso` y sus funciones no existen y las que deben usar el resolvedor aun deciden por `rol IN (...)`.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";

let admin: Pool;
beforeAll(() => {
  admin = abrirAdmin(2);
});
afterAll(async () => {
  await admin?.end();
});

interface Fn {
  nombre: string;
  esquema: string;
  prosrc: string;
  secdef: boolean;
  config: string | null;
  dueno: string;
  esTrigger: boolean;
}
let todas: Fn[];
const cargar = async (): Promise<Fn[]> =>
  (
    await admin.query(
      `select n.nspname || '.' || p.proname as nombre, n.nspname as esquema, p.prosrc, p.prosecdef as secdef, p.proconfig::text as config,
              pg_get_userbyid(p.proowner) as dueno,
              exists (select 1 from pg_trigger t where t.tgfoid = p.oid and not t.tgisinternal) as es_trigger
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and p.prokind = 'f'`,
    )
  ).rows.map((r) => ({ nombre: r.nombre, esquema: r.esquema, prosrc: r.prosrc, secdef: r.secdef, config: r.config, dueno: r.dueno, esTrigger: r.es_trigger }));
const fns = async () => (todas ??= await cargar());
const menciona = (f: Fn, re: RegExp) => re.test(f.prosrc);
const nombres = (xs: Fn[]) => xs.map((f) => f.nombre).sort();

// ---- el inventario conocido (estado de 029 mas lo que 0082 reemplaza) ------------------------------------------------------------------
/** Deciden acceso por el rol de la membresia: 0082 las reemplaza para que usen `acceso.permisos_membresia` (D3). */
const RESUELVEN = ["auth.invitacion_aceptar_existente", "auth.invitacion_aceptar_nueva", "auth.invitacion_vigente", "auth.totp_desactivar"];
/** Copian el rol de la invitacion a la membresia: ahora tambien `rol_id`. */
const COPIAN_ROL_ID = ["auth.invitacion_aceptar_existente", "auth.invitacion_aceptar_nueva"];
/** U10: avisos y destinatarios que siguen explicitos para Dueño y Administrador; se prueban con 'propio' (roles-efectivos.spec.ts). */
const EXPLICITAS_U10 = [
  "auth.correo_baja_aplicar",
  "interno.destinatarios_cliente",
  "interno.notificar",
  "interno.uso_plan",
  "public.correo_envio_tomar",
  "public.correo_preferencia_efectiva",
  "public.correo_preferencias_fijar",
  "public.notificacion_credencial_invalida",
];
/** Sin cambio de logica: registro (Dueño fijo), auditoria (copia lo que ve), correo (lee el rol) y el trigger del ultimo Dueño (U7). */
const SIN_CAMBIO = [
  "auth.registro_confirmar_existente",
  "auth.registro_confirmar_nueva",
  "interno.membresia_via",
  "public.auditoria_capturar_invitacion",
  "public.auditoria_capturar_membresia",
  "public.correo_destinatario",
  "public.membresia_ultimo_dueno",
];
const CONOCIDAS = [...RESUELVEN, ...EXPLICITAS_U10, ...SIN_CAMBIO].filter((v, i, a) => a.indexOf(v) === i).sort();

describe("inventario cerrado de funciones que mencionan `rol` (plan.md#riesgos)", () => {
  it("las clases del inventario no se pisan mas que donde se espera y suman 19 funciones conocidas", () => {
    expect(CONOCIDAS).toHaveLength(19);
    expect(RESUELVEN.filter((f) => EXPLICITAS_U10.includes(f))).toEqual([]);
    expect(SIN_CAMBIO.filter((f) => EXPLICITAS_U10.includes(f) || RESUELVEN.includes(f))).toEqual([]);
  });

  it("fuera del esquema acceso y de las funciones de disparador de rol propio, la lista de funciones que mencionan `rol` es EXACTAMENTE la conocida", async () => {
    const quienes = (await fns()).filter((f) => f.esquema !== "acceso" && menciona(f, /\brol\b/i));
    const sinDisparadoresNuevos = quienes.filter((f) => !(f.esTrigger && menciona(f, /permisos_membresia|acceso\.(rol|permisos)/)));
    expect(nombres(sinDisparadoresNuevos)).toEqual(CONOCIDAS);
  });

  it("solo las funciones de la clase RESUELVEN (y los disparadores de asignacion) llaman a acceso.permisos_membresia fuera del esquema acceso", async () => {
    const quienes = (await fns()).filter((f) => f.esquema !== "acceso" && menciona(f, /permisos_membresia/));
    const disparadores = quienes.filter((f) => f.esTrigger);
    const resto = quienes.filter((f) => !f.esTrigger);
    expect(nombres(resto)).toEqual(RESUELVEN);
    for (const t of disparadores) expect(t.secdef || t.dueno === "contapp_migrator", t.nombre).toBe(true);
  });

  it("las clases RESUELVEN ya no deciden por `rol IN ('dueno', 'admin')` ni por `g.rol = 'dueno'`", async () => {
    for (const f of (await fns()).filter((x) => RESUELVEN.includes(x.nombre))) {
      expect(f.prosrc, f.nombre).not.toMatch(/\.rol\s+IN\s*\(\s*'dueno'/i);
      expect(f.prosrc, f.nombre).not.toMatch(/\bg\.rol\s*=\s*'dueno'/i);
    }
  });

  it("las funciones que copian el rol de la invitacion copian tambien rol_id", async () => {
    for (const f of (await fns()).filter((x) => COPIAN_ROL_ID.includes(x.nombre))) expect(f.prosrc, f.nombre).toMatch(/\brol_id\b/);
  });

  it("U10: las explicitas no usan el resolvedor ni rol_id; siguen decidiendo por 'dueno' y 'admin' (o por 'dueno' en el limite del plan)", async () => {
    for (const f of (await fns()).filter((x) => EXPLICITAS_U10.includes(x.nombre))) {
      expect(f.prosrc, f.nombre).not.toMatch(/permisos_membresia|\brol_id\b|'propio'/);
    }
    const por = async (n: string) => (await fns()).find((f) => f.nombre === n)!;
    for (const n of ["interno.destinatarios_cliente", "public.notificacion_credencial_invalida"]) expect((await por(n)).prosrc, n).toMatch(/'dueno'\s*,\s*'admin'/);
    expect((await por("interno.uso_plan")).prosrc).toMatch(/rol\s*=\s*'dueno'/);
  });

  it("U7: el trigger del ultimo Dueño sigue contando solo rol = 'dueno' (un propio nunca lo es)", async () => {
    const f = (await fns()).find((x) => x.nombre === "public.membresia_ultimo_dueno")!;
    expect(f.prosrc).toMatch(/rol\s*=\s*'dueno'/);
    expect(f.prosrc).not.toMatch(/propio|permisos_membresia|rol_id/);
  });
});

describe("esquema acceso y funciones nuevas (D3, D4, CA-9)", () => {
  it("el esquema acceso existe, es del migrador y ningun rol de la app puede crear en el", async () => {
    const [s] = (await admin.query("select pg_get_userbyid(nspowner) as dueno from pg_namespace where nspname = 'acceso'")).rows;
    expect(s?.dueno).toBe("contapp_migrator");
    const r = (
      await admin.query(
        `select r, has_schema_privilege(r, 'acceso', 'CREATE') as crea, has_schema_privilege(r, 'acceso', 'USAGE') as usa
           from unnest(array['contapp_backend', 'contapp_worker', 'contapp_platform', 'contapp_app']) r`,
      )
    ).rows;
    expect(r.filter((x) => x.crea)).toEqual([]);
    expect(r.find((x) => x.r === "contapp_backend")?.usa).toBe(true);
  });

  it("tiene las cuatro funciones del plan y todas las del esquema son SECURITY DEFINER, con search_path fijo y del migrador", async () => {
    const enAcceso = (await fns()).filter((f) => f.esquema === "acceso");
    const planeadas = ["acceso.permisos_membresia", "acceso.rol_eliminar", "acceso.rol_guardar", "acceso.rol_impacto"];
    expect(nombres(enAcceso)).toEqual(expect.arrayContaining(planeadas));
    for (const f of enAcceso) {
      expect(f.secdef, f.nombre).toBe(true);
      expect(f.config, f.nombre).toContain("search_path=pg_catalog, pg_temp");
      expect(f.dueno, f.nombre).toBe("contapp_migrator");
    }
  });

  it("EXECUTE: PUBLIC no lo tiene; contapp_backend solo ejecuta rol_guardar, rol_eliminar y rol_impacto; worker, platform y app, ninguna", async () => {
    const firmas: Record<string, string> = {
      permisos_membresia: "acceso.permisos_membresia(uuid, uuid)",
      rol_guardar: "acceso.rol_guardar(uuid, text, text, text[])",
      rol_eliminar: "acceso.rol_eliminar(uuid)",
      rol_impacto: "acceso.rol_impacto(uuid, text, text[])",
    };
    const quien = async (firma: string) =>
      (
        await admin.query(
          `select r from unnest(array['contapp_backend', 'contapp_worker', 'contapp_platform', 'contapp_app']) r where has_function_privilege(r, $1, 'EXECUTE')`,
          [firma],
        )
      ).rows.map((x) => x.r as string);
    const vistos: Record<string, string[]> = {};
    for (const [n, f] of Object.entries(firmas)) vistos[n] = await quien(f);
    expect(vistos).toEqual({
      permisos_membresia: [],
      rol_guardar: ["contapp_backend"],
      rol_eliminar: ["contapp_backend"],
      rol_impacto: ["contapp_backend"],
    });
    for (const f of Object.values(firmas)) {
      const [{ n }] = (await admin.query("select count(*)::int as n from aclexplode((select proacl from pg_proc where oid = $1::regprocedure)) a where a.grantee = 0", [f])).rows;
      expect(n, `${f}: EXECUTE a PUBLIC`).toBe(0);
    }
  });

  it("las funciones nuevas no arman SQL dinamico ni desactivan la RLS ni los disparadores (revision estatica minima)", async () => {
    const nuevas = (await fns()).filter((x) => x.esquema === "acceso");
    expect(nuevas.length, "funciones del esquema acceso").toBeGreaterThanOrEqual(4);
    for (const f of nuevas) {
      expect(f.prosrc, f.nombre).not.toMatch(/\bEXECUTE\s+(format\(|'[^']*'\s*\|\|)/i);
      expect(f.prosrc, f.nombre).not.toMatch(/session_replication_role|DISABLE\s+TRIGGER|row_security\s*=\s*off/i);
    }
  });

  it("el bloqueo de D4: rol_guardar y rol_eliminar toman primero el advisory `acceso.roles:` y despues bloquean membresias y el rol", async () => {
    for (const n of ["acceso.rol_guardar", "acceso.rol_eliminar"]) {
      const f = (await fns()).find((x) => x.nombre === n);
      expect(f, n).toBeDefined();
      const adv = f!.prosrc.search(/pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*'acceso\.roles:'/);
      expect(adv, `${n}: advisory acceso.roles:<tenant>`).toBeGreaterThanOrEqual(0);
      for (const despues of [/FROM\s+(public\.)?membresia[^;]*FOR UPDATE/i, /FROM\s+(public\.)?rol\b[^;]*FOR UPDATE/i]) {
        const i = f!.prosrc.search(despues);
        if (i >= 0) expect(i, `${n}: ${despues} despues del advisory`).toBeGreaterThan(adv);
      }
    }
  });
});

describe("disparadores de asignacion en membresia e invitacion (D2)", () => {
  it.each(["membresia", "invitacion"])("%s: hay un disparador BEFORE ROW de INSERT y UPDATE con el resolvedor", async (tabla) => {
    const r = (
      await admin.query(
        `select t.tgname, t.tgtype, p.prosrc from pg_trigger t join pg_proc p on p.oid = t.tgfoid
          where t.tgrelid = $1::regclass and not t.tgisinternal and p.prosrc ~ '(permisos_membresia|acceso[.](rol|permisos))'`,
        [`public.${tabla}`],
      )
    ).rows;
    expect(r.length, `${tabla}: disparador de asignacion`).toBeGreaterThanOrEqual(1);
    const t = r[0];
    expect(t.tgtype & 1, "ROW").toBe(1);
    expect(t.tgtype & 2, "BEFORE").toBe(2);
    expect(t.tgtype & 4, "INSERT").toBe(4);
    expect(t.tgtype & 16, "UPDATE").toBe(16);
  });
});
