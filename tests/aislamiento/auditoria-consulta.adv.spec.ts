// Spec 031 · T9 (adversario, ronda 1): ataques de BD a la consulta de auditoría con filtros y alcance (D-1, D-3, D-7, D-8; CA-4,
// CA-5, CA-7, CA-8). Caja negra primero (contrato de plan.md: listarAuditoria/opcionesAuditoria con `alcance` obligatorio,
// auditoria_descifrado_listar con falla cerrado) y luego caja blanca sobre lectura.ts, opciones.ts y 0088:
//   - `alcance` con formas hostiles (null, vacío, mayúsculas, string, arreglo, sin usuario) nunca muestra de más, ni en opciones.
//   - filtros con formas raras (arreglo vacío, [null], string en vez de arreglo, texto SQL) nunca amplían la referencia.
//   - cursor forjado con la posición de una fila de OTRO estudio no cruza la RLS.
//   - la función con valores extremos (±infinity, límite máximo) no abre el alcance asignado.
//   - public.auditoria_ms (IMMUTABLE, LEAKPROOF): EXECUTE solo del worker; nadie de la app la redefine ni crea una sombra; no lanza
//     para ningún valor (un LEAKPROOF que lanza sería un oráculo bajo la RLS); el worker no lee descifrados por ella.
//   - 003 y 017 CA-3 intactos: el worker sigue insertando descifrados (la expresión del índice usa auditoria_ms) y nadie de la app
//     modifica `auditoria` ni `auditoria_descifrado`.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auditoria-soporte";
import { D1, EscenarioConsulta, H, SIN_FILTROS, filtros, type Alcance, type FilaRef, type Filtros } from "./auditoria-consulta-soporte";
import { abrirPool, filasRaw, intentar, intentarRaw, type Tx } from "./soporte";

let admin: Pool;
let app: Pool;
let ec: EscenarioConsulta;
let X: string;
let Y: string;
let u1: string; // asignado a c1
let uSin: string; // sin asignaciones
let uy: string; // miembro de Y asignado a cy1
let c1: string;
let c2: string;
let cy1: string;
const R: Record<string, string> = {};
let volX: FilaRef[];
let asigX: Map<string, Set<string>>;

beforeAll(async () => {
  admin = abrirAdmin(4);
  app = abrirPool(2);
  ec = new EscenarioConsulta(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  u1 = (await ec.miembro(X)).id;
  uSin = (await ec.miembro(X)).id;
  uy = (await ec.miembro(Y)).id;
  c1 = (await ec.cliente(X)).id;
  c2 = (await ec.cliente(X)).id;
  cy1 = (await ec.cliente(Y)).id;
  await ec.asignar(X, c1, u1, "responsable");
  await ec.asignar(Y, cy1, uy, "responsable");
  R.c1 = await ec.audit(X, { ms: D1 + H, accion: "cliente.editado", usuario: u1, cliente: c1 });
  R.c2 = await ec.audit(X, { ms: D1 + 2 * H, accion: "cliente.editado", usuario: u1, cliente: c2 });
  R.sin = await ec.audit(X, { ms: D1 + 3 * H, accion: "miembro.rol_cambiado", usuario: u1 });
  R.dc1 = await ec.descifrado(X, { en: D1 + 4 * H, cliente: c1 });
  R.dc2 = await ec.descifrado(X, { en: D1 + 5 * H, cliente: c2 });
  R.dsin = await ec.descifrado(X, { en: D1 + 6 * H });
  R.y = await ec.audit(Y, { ms: D1 + 7 * H, accion: "cliente.editado", usuario: uy, cliente: cy1 });
  R.dy = await ec.descifrado(Y, { en: D1 + 8 * H, cliente: cy1, motivo: "MOTIVO-Y-ADV-031" });
  volX = await ec.volcado(X);
  asigX = await ec.asignaciones(X);
}, 120_000);

afterAll(async () => {
  await ec?.limpiar();
  await ec?.cerrar();
  await app?.end();
  await admin?.end();
});

const listar = (tenantId: string, userId: string | undefined, o: unknown): Promise<{ id: string; clienteId: string | null }[]> => {
  const f = exportado<(tx: Tx, o: unknown) => Promise<{ id: string; clienteId: string | null }[]>>("listarAuditoria");
  return ec.comoBackend(tenantId, userId, (tx) => f(tx, o));
};
const opciones = (tenantId: string, userId: string | undefined, o: unknown) => {
  const f = exportado<(tx: Tx, o: unknown) => Promise<{ miembros: { id: string }[]; clientes: { id: string }[] }>>("opcionesAuditoria");
  return ec.comoBackend(tenantId, userId, (tx) => f(tx, o));
};
/** Resultado o error (un error también es falla cerrada; lo que importa es que nunca salga una fila de más). */
const intento = async <T>(p: Promise<T>): Promise<T | "error"> => p.catch(() => "error" as const);

/** Alcances que NO son exactamente `{ tipo: "global" }` ni un asignado con usuario real asignado. */
const ALCANCES_HOSTILES: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["objeto vacío", {}],
  ["string 'global'", "global"],
  ["arreglo ['global']", ["global"]],
  ["tipo en mayúsculas", { tipo: "GLOBAL" }],
  ["tipo con espacio", { tipo: "global " }],
  ["tipo null", { tipo: null, usuarioId: "__u1__" }],
  ["asignado sin usuario", { tipo: "asignado" }],
  ["asignado con usuario null", { tipo: "asignado", usuarioId: null }],
  ["asignado con usuario vacío", { tipo: "asignado", usuarioId: "" }],
  ["asignado con usuario numérico", { tipo: "asignado", usuarioId: 1 }],
  ["asignado con usuario sin asignaciones", { tipo: "asignado", usuarioId: "__uSin__" }],
  ["asignado con usuario de otro estudio", { tipo: "asignado", usuarioId: "__uy__" }],
  ["asignado con uuid nulo", { tipo: "asignado", usuarioId: "00000000-0000-0000-0000-000000000000" }],
];
const resolver = (a: unknown): unknown => {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return a;
  const u = (a as { usuarioId?: unknown }).usuarioId;
  return { ...a, usuarioId: u === "__uSin__" ? uSin : u === "__uy__" ? uy : u === "__u1__" ? u1 : u };
};

// =================================================================================================
describe("ADV-1 · alcance hostil: un null, vacío o mal escrito nunca muestra de más (D-3, falla cerrado)", () => {
  it.each(ALCANCES_HOSTILES)("listarAuditoria con alcance %s: vacío o error, sin filtros y con clienteId", async (_n, a) => {
    const alcance = resolver(a);
    for (const f of [SIN_FILTROS, filtros({ clienteId: c1 }), filtros({ acciones: ["credencial.descifrada"] })]) {
      const r = await intento(listar(X, u1, { alcance, filtros: f, limite: 50 }));
      // Lo no global con un usuario real vale como SU alcance asignado (c1), nunca como global; lo demás, nada.
      const esperado = a === ALCANCES_HOSTILES[7]![1] ? ec.referencia(volX, asigX, f, { tipo: "asignado", usuarioId: u1 }) : [];
      expect(r === "error" ? [] : r.map((x) => x.id), JSON.stringify({ alcance, f })).toEqual(esperado);
    }
    // Sin la clave `alcance` (el tipo lo exige; en tiempo de ejecución no debe valer como global).
    const sinClave = await intento(listar(X, u1, { filtros: SIN_FILTROS }));
    expect(sinClave === "error" ? [] : sinClave).toEqual([]);
  });

  it("opcionesAuditoria con cada alcance hostil: ningún cliente (ni por q ni por clienteId)", async () => {
    for (const [n, a] of ALCANCES_HOSTILES) {
      const r = await intento(opciones(X, u1, { q: "e", clienteId: c2, alcance: resolver(a) }));
      expect(r === "error" ? [] : r.clientes.filter((c) => c.id !== c1), n).toEqual([]);
      if (n !== "tipo null") expect(r === "error" ? [] : r.clientes, n).toEqual([]);
    }
  });
});

// =================================================================================================
describe("ADV-2 · filtros con formas raras nunca amplían la referencia (D-1, CA-7)", () => {
  const ref = (f: Filtros, a: Alcance): string[] => ec.referencia(volX, asigX, f, a);
  const global: Alcance = { tipo: "global" };

  it.each<[string, Record<string, unknown>]>([
    ["acciones vacías", { acciones: [] }],
    ["acciones [null]", { acciones: [null] }],
    ["acciones como string (no arreglo)", { acciones: "credencial.descifrada" }],
    ["acción con texto SQL", { acciones: ["cliente.editado' or '1'='1"] }],
    ["acción con ; y comentario", { acciones: ["x'); delete from auditoria; --"] }],
    ["usuarioId vacío", { usuarioId: "" }],
    ["clienteId vacío", { clienteId: "" }],
    ["clienteId con inyección", { clienteId: `${"0".repeat(8)}' or true --` }],
    ["desde inválido", { desde: new Date(Number.NaN) }],
  ])("global con %s: vacío o error; nunca más filas que la referencia", async (_n, raro) => {
    const total = async () =>
      Number((await admin.query("select (select count(*) from auditoria) + (select count(*) from auditoria_descifrado) as n")).rows[0].n);
    const antes = await total();
    const r = await intento(listar(X, u1, { alcance: global, filtros: { ...SIN_FILTROS, ...raro }, limite: 50 }));
    const ids = r === "error" ? [] : r.map((x) => x.id);
    expect(ids, "con un filtro raro no debe salir NADA (no se pliega a «sin filtro»)").toEqual([]);
    expect(await total()).toBe(antes);
  });

  it("fechas límite que la API puede producir (rangoLima de 0000-01-01 y 9999-12-31) y límite enorme, con alcance asignado: solo c1", async () => {
    const r = await listar(X, u1, {
      alcance: { tipo: "asignado", usuarioId: u1 },
      filtros: filtros({ desde: new Date(Date.UTC(0, 0, 1, 5)), hastaExclusivo: new Date(Date.UTC(9999, 11, 32, 5)) }),
      limite: Number.MAX_SAFE_INTEGER,
    });
    expect(r.map((x) => x.id)).toEqual(ref(SIN_FILTROS, { tipo: "asignado", usuarioId: u1 }));
    expect(r.every((x) => x.clienteId === c1)).toBe(true);
  });

  it("cursor forjado con la posición (instante, id) de una fila de OTRO estudio: solo filas de X anteriores a ese instante", async () => {
    const enY = new Date(D1 + 7 * H);
    const r = await listar(X, u1, { alcance: global, antes: { en: enY, id: R.y }, limite: 50 });
    const esperado = volX
      .filter((f) => f.ms < enY.getTime() || (f.ms === enY.getTime() && f.id < R.y))
      .sort((a, b) => b.ms - a.ms || (a.id < b.id ? 1 : -1))
      .map((f) => f.id);
    expect(r.map((x) => x.id)).toEqual(esperado);
    expect(r.map((x) => x.id)).not.toContain(R.y);
    expect(r.map((x) => x.id)).not.toContain(R.dy);
  });
});

// =================================================================================================
describe("ADV-3 · auditoria_descifrado_listar con valores límite no abre el alcance ni cruza estudios (D-3, CA-5)", () => {
  it("p_global = false con ±infinity, límite máximo y cursor infinito: solo c1 de X; con la sesión de Y y p_usuario de X, nada", async () => {
    const sqlF =
      "select id, cliente_id from auditoria_descifrado_listar('infinity'::timestamptz, null, 2147483647, null, '-infinity'::timestamptz, 'infinity'::timestamptz, false, $1::uuid)";
    const enX = await ec.comoBackend(X, u1, async (tx) => (await tx.query(sqlF, [u1])).rows);
    expect(enX.map((f) => f.id)).toEqual([R.dc1]);
    const enY = await ec.comoBackend(Y, uy, async (tx) => (await tx.query(sqlF, [u1])).rows);
    expect(enY).toEqual([]);
    const enYGlobal = await ec.comoBackend(Y, uy, async (tx) =>
      (await tx.query("select id from auditoria_descifrado_listar(null, null, 50, $1::uuid, null, null, true, null)", [c1])).rows,
    );
    expect(enYGlobal, "cliente de X con la sesión de Y y p_global = true").toEqual([]);
  });
});

// =================================================================================================
describe("ADV-4 · public.auditoria_ms (IMMUTABLE, LEAKPROOF): nadie de la app la abusa", () => {
  const ROLES = ["contapp_backend", "contapp_worker", "contapp_app", "contapp_platform", "contapp_auth", "contapp_enumerador", "contapp_registrador"];

  it("atributos y grants: sql, no SECURITY DEFINER, dueño contapp_migrator, search_path fijo, EXECUTE solo contapp_worker", async () => {
    const f = (
      await admin.query(
        `select p.oid, l.lanname, p.prosecdef, p.proleakproof, p.provolatile, p.proisstrict, p.proconfig, pg_get_userbyid(p.proowner) as dueno,
                (select count(*) from pg_proc q where q.proname = 'auditoria_ms') as sobrecargas
           from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'public.auditoria_ms(timestamptz)'::regprocedure`,
      )
    ).rows[0];
    expect(f).toMatchObject({ lanname: "sql", prosecdef: false, proleakproof: true, provolatile: "i", proisstrict: true, dueno: "contapp_migrator" });
    expect(Number(f.sobrecargas), "ninguna sobrecarga ni sombra en otro esquema").toBe(1);
    expect((f.proconfig as string[]).join(" ")).toMatch(/search_path=pg_catalog, pg_temp/);
    const con: string[] = [];
    for (const rol of ROLES) {
      if ((await admin.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as v", [rol, f.oid])).rows[0].v) con.push(rol);
    }
    expect(con).toEqual(["contapp_worker"]);
    expect((await admin.query("select has_function_privilege('public', $1::oid, 'EXECUTE') as v", [f.oid])).rows[0].v).toBe(false);
  });

  it("contapp_app (sin SET ROLE) y contapp_backend: permission denied al ejecutarla", async () => {
    for (const rol of [null, "contapp_backend"]) {
      const r = await intentarRaw(app, rol, "select public.auditoria_ms(now())");
      expect(r.ok ? "ok" : r.code, String(rol)).toBe("42501");
    }
  });

  it("no lanza para ningún valor (un LEAKPROOF que lanza es un oráculo bajo la RLS) y coincide con date_trunc en UTC", async () => {
    const valores = [
      "infinity",
      "-infinity",
      "4713-01-01 00:00:00+00 BC",
      "294276-12-31 23:59:59.999999+00",
      "1970-01-01 00:00:00+00",
      "2026-03-11 04:59:59.999999+00",
      "2026-03-11 05:00:00.000001-05",
      "2000-02-29 23:59:59.9995+14",
    ];
    const r = await filasRaw(
      app,
      "contapp_worker",
      `select bool_and(public.auditoria_ms(v) is not distinct from (date_trunc('milliseconds', v at time zone 'UTC') at time zone 'UTC')) as ok,
              count(*) filter (where public.auditoria_ms(v) is null) as nulos
         from unnest($1::timestamptz[]) v`,
      [valores],
    );
    expect(r).toEqual([{ ok: true, nulos: "0" }]);
    expect(await filasRaw(app, "contapp_worker", "select public.auditoria_ms(null) is null as v")).toEqual([{ v: true }]);
  });

  it("ningún rol de la app la redefine, la altera, crea una sobrecarga en public ni marca LEAKPROOF una función propia", async () => {
    const intentos = [
      "create or replace function public.auditoria_ms(p timestamptz) returns timestamptz language sql immutable as $$ select p $$",
      "alter function public.auditoria_ms(timestamptz) volatile",
      "alter function public.auditoria_ms(timestamptz) reset search_path",
      "create function public.auditoria_ms(p timestamp) returns timestamptz language sql immutable as $$ select now() $$",
      "create function pg_temp.fuga(p timestamptz) returns timestamptz language sql immutable leakproof as $$ select p $$",
    ];
    for (const rol of [null, "contapp_backend", "contapp_worker"]) {
      for (const s of intentos) {
        const r = await intentarRaw(app, rol, s);
        expect(r.ok ? "ok" : "rechazado", `${rol ?? "contapp_app"}: ${s}`).toBe("rechazado");
      }
    }
    const f = (await admin.query("select proleakproof, provolatile, proconfig from pg_proc where oid = 'public.auditoria_ms(timestamptz)'::regprocedure")).rows[0];
    expect(f.proleakproof).toBe(true);
    expect(f.provolatile).toBe("i");
  });

  it("el worker no lee auditoria_descifrado aunque use auditoria_ms en el WHERE (sigue sin SELECT, 003)", async () => {
    for (const s of [
      "select count(*) from auditoria_descifrado where public.auditoria_ms(created_at) > '-infinity'",
      "select 1 from auditoria_descifrado d where public.auditoria_ms(d.created_at) = public.auditoria_ms(d.created_at) limit 1",
    ]) {
      const r = await intentar(ec.worker, { tenantId: X }, s);
      expect(r.ok ? "ok" : r.code, s).toBe("42501");
    }
  });
});

// =================================================================================================
describe("ADV-5 · 003 y 017 CA-3 intactos tras 0088", () => {
  it("el worker sigue insertando descifrados (la expresión del índice usa auditoria_ms) y no los modifica ni borra", async () => {
    const ins = await intentar(
      ec.worker,
      { tenantId: X },
      "insert into auditoria_descifrado (credencial_id, cliente_id, tipo, motivo, resultado) values (gen_random_uuid(), $1, 'sol', 'adv.031', 'ok')",
      [c1],
    );
    expect(ins).toEqual({ ok: true, rowCount: 1 });
    for (const s of ["update auditoria_descifrado set motivo = 'x'", "delete from auditoria_descifrado", "truncate auditoria_descifrado"]) {
      const r = await intentar(ec.worker, { tenantId: X }, s);
      expect(r.ok ? "ok" : r.code, s).toBe("42501");
    }
  });

  it("backend y worker: INSERT, UPDATE, DELETE y TRUNCATE sobre auditoria siguen en permission denied (017 CA-3)", async () => {
    const sentencias = [
      "insert into auditoria (actor_tipo, accion, entidad, datos) values ('sistema', 'cliente.editado', 'cliente', '{}')",
      "update auditoria set datos = '{}'",
      "delete from auditoria",
      "truncate auditoria",
    ];
    for (const [nombre, db] of [["backend", ec.backend], ["worker", ec.worker]] as const) {
      for (const s of sentencias) {
        const r = await intentar(db, { tenantId: X, userId: u1 }, s);
        expect(r.ok ? "ok" : r.code, `${nombre}: ${s}`).toBe("42501");
      }
    }
  });
});
