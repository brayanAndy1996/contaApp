// Spec 007a (T1, rojo): comportamiento de BD de clientes archivados (CA-2, CA-5, CA-7; D4, D5). Sin HTTP: cada flujo replica el
// orden de bloqueo que fija el plan sobre los repos reales de 005/006, y las escrituras de `cliente` usan SQL directo con las
// columnas de la migracion 0026 (T7 las envuelve en `crearCliente`/`archivarCliente`/`reactivarCliente`).
//
// Contrato que fija:
//   contarRucs(tx, tenantId) y usoDelEstudio(tx, tenantId).rucsUsados cuentan solo `archivado_at IS NULL` (T5).
//   revalidarEncolado(tx, { clienteId, creadoPor, rolesPermitidos }) devuelve 'acceso_retirado' si el cliente esta archivado,
//       tambien con `creadoPor = null` (trabajo `programado`), y 'ok' al reactivarlo (T8; agrega `c.archivado_at is null`).
// Orden de bloqueo (plan.md, Decisiones): bloquearMiembros(actor y responsable) -> CupoRucs.reservar (= bloquearCupo + contar +
//   comparar con el limite) -> cliente -> asignacion. Archivar toca solo `cliente` por id: sin bloqueo de cupo ni de miembros.
// Sin reintentos de 40P01: cualquier interbloqueo (o cualquier error que no sea el rechazo esperado) hace fallar la prueba.
// Ajuste a lo existente: ninguna prueba de 002-008 archiva clientes, asi que sus conteos totales de `cliente` (p. ej. contarRucs
// en planes-carreras.spec.ts) siguen valiendo igual con el conteo de activos; no hay nada que modificar alli.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, crearDb, exportado } from "./auth-soporte";
import { EscenarioPlanes } from "./planes-soporte";
import type { ContappDb, Tx } from "./soporte";

type Fn = (...a: any[]) => Promise<any>;
const bloquearCupo = (tx: Tx, t: string): Promise<void> => exportado<Fn>("bloquearCupo")(tx, t);
const contarRucs = (tx: Tx, t: string): Promise<number> => exportado<Fn>("contarRucs")(tx, t);
const usoDelEstudio = (tx: Tx, t: string): Promise<{ rucsUsados: number } | null> => exportado<Fn>("usoDelEstudio")(tx, t);
const bloquearMiembros = (tx: Tx, ids: string[]) => exportado<Fn>("bloquearMiembros")(tx, ids);
const asignarRepo = (tx: Tx, a: { clienteId: string; usuarioId: string; tipo: "responsable" | "colaborador" }) =>
  exportado<Fn>("asignar")(tx, a);
const revalidarEncolado = (tx: Tx, t: { clienteId: string; creadoPor: string | null; rolesPermitidos: string[] | null }) =>
  exportado<Fn>("revalidarEncolado")(tx, t) as Promise<"ok" | "acceso_retirado">;

let admin: Pool;
let ep: EscenarioPlanes;
const dbs: ContappDb[] = [];
beforeAll(() => {
  admin = abrirAdmin(6);
  ep = new EscenarioPlanes(admin);
});
afterAll(async () => {
  await ep?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await admin?.end();
});

// Un pool por rol para todo el archivo (las suites comparten una BD con pocas conexiones): el de backend admite las 18 a la vez.
const pools = new Map<string, ContappDb>();
const dbDe = (rol: "contapp_backend" | "contapp_worker", _max = 0): ContappDb => {
  let d = pools.get(rol);
  if (!d) {
    d = crearDb(rol, rol === "contapp_backend" ? 24 : 3);
    pools.set(rol, d);
    dbs.push(d);
  }
  return d;
};
const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pausa = (tx: Tx, ms: number) => tx.query("select pg_sleep($1::float8)", [ms / 1000]);
class CupoLleno extends Error {}

const archivarAdmin = (ids: string[]) => adm("update cliente set archivado_at = now() where id = any($1::uuid[])", [ids]);
const reactivarAdmin = (ids: string[]) => adm("update cliente set archivado_at = null where id = any($1::uuid[])", [ids]);
const activosDe = async (t: string) =>
  (await adm("select count(*)::int n from cliente where tenant_id = $1 and archivado_at is null", [t]))[0].n as number;
const totalDe = async (t: string) =>
  (await adm("select count(*)::int n from cliente where tenant_id = $1", [t]))[0].n as number;

let seqRuc = 0;
/** RUC de 11 digitos que no choca con los de EscenarioAcceso (que empiezan en 2). */
const rucNuevo = () => `1${String(++seqRuc).padStart(10, "0")}`;

interface Est {
  x: { id: string };
  miembros: { id: string }[];
  max: number;
  activos: string[];
  archivados: string[];
}

/** Estudio con plan de `max` RUCs (sin adicionales), 4 miembros activos, `activos` clientes activos y `archivados` archivados. */
async function estudio(max: number, activos: number, archivados = 0): Promise<Est> {
  const p = await ep.plan({ maxRucs: max, maxRucsExtra: 0, maxUsuarios: 10 });
  const e = await ep.estudioConUsuarios(p.id, { activos: 4 });
  const ids = activos + archivados > 0 ? await ep.ea.clientes(e.x.id, activos + archivados) : [];
  const archivadosIds = ids.slice(activos);
  if (archivadosIds.length > 0) await archivarAdmin(archivadosIds);
  return { x: e.x, miembros: e.miembros, max, activos: ids.slice(0, activos), archivados: archivadosIds };
}

const LIMITE = `select p.max_rucs + least(s.rucs_extra_contratados, p.max_rucs_extra) as limite
  from suscripcion s join plan p on p.id = s.plan_id`;

/** Lo que hace CupoRucs.reservar(tx, tenant, 1): toma el bloqueo, cuenta activos y compara con el limite efectivo. */
async function reservar(tx: Tx, tenantId: string): Promise<void> {
  await bloquearCupo(tx, tenantId);
  const limite = Number((await tx.query(LIMITE)).rows[0].limite);
  if ((await contarRucs(tx, tenantId)) + 1 > limite) throw new CupoLleno();
}

// ---- Flujos de la spec (D4): cada uno devuelve su efecto sobre la cuenta de activos (+1, -1, 0) --------------------------
const crear = (db: ContappDb, e: Est, actor: string, ruc = rucNuevo()) =>
  db.withTenant({ tenantId: e.x.id, userId: actor }, async (tx) => {
    await bloquearMiembros(tx, [actor]);
    await reservar(tx, e.x.id);
    const r = await tx.query("insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, $3) returning id", [
      e.x.id,
      ruc,
      `RUC ${ruc}`,
    ]);
    await asignarRepo(tx, { clienteId: r.rows[0].id as string, usuarioId: actor, tipo: "responsable" });
    await pausa(tx, 120);
    return 1;
  });

const reactivar = (db: ContappDb, e: Est, actor: string, clienteId: string) =>
  db.withTenant({ tenantId: e.x.id, userId: actor }, async (tx) => {
    await bloquearMiembros(tx, [actor]);
    await reservar(tx, e.x.id);
    const r = await tx.query("update cliente set archivado_at = null where id = $1 and archivado_at is not null", [clienteId]);
    await pausa(tx, 120);
    return r.rowCount ?? 0;
  });

/** Archivar solo libera: ni bloqueo de cupo ni de miembros. Idempotente (0 si ya estaba archivado). */
const archivar = (db: ContappDb, e: Est, clienteId: string) =>
  db.withTenant({ tenantId: e.x.id }, async (tx) => {
    const r = await tx.query("update cliente set archivado_at = now() where id = $1 and archivado_at is null", [clienteId]);
    await pausa(tx, 120);
    return 0 - (r.rowCount ?? 0); // 0 - n evita el -0 de la negacion
  });

/** Asignar (005) despues de bloquear miembros; sobre un archivado T8 lo rechaza con ClienteArchivadoError (tolerado aqui). */
const asignar = (db: ContappDb, e: Est, actor: string, usuario: string, clienteId: string) =>
  db.withTenant({ tenantId: e.x.id, userId: actor }, async (tx) => {
    await bloquearMiembros(tx, [actor, usuario]);
    await asignarRepo(tx, { clienteId, usuarioId: usuario, tipo: "colaborador" });
    await pausa(tx, 120);
    return 0;
  });

interface Flujo {
  tipo: string;
  ir: (db: ContappDb) => Promise<number>;
}
type Resultado = { tipo: string; q: PromiseSettledResult<number> };

/** Lanza todo a la vez (orden aleatorio, desfase corto) con conexiones separadas y devuelve los resultados. */
async function correr(flujos: Flujo[]): Promise<Resultado[]> {
  const db = dbDe("contapp_backend");
  const orden = [...flujos].sort(() => Math.random() - 0.5);
  const r = await Promise.allSettled(orden.map((f, i) => dormir(i * 15).then(() => f.ir(db))));
  return r.map((q, i) => ({ tipo: orden[i]!.tipo, q }));
}

const esperado = (reason: unknown): boolean =>
  reason instanceof CupoLleno || (reason as { name?: string } | null)?.name === "ClienteArchivadoError";

const sinOtrosErrores = (res: Resultado[]) => {
  const raros = res
    .filter((r): r is { tipo: string; q: PromiseRejectedResult } => r.q.status === "rejected" && !esperado(r.q.reason))
    .map((r) => `${r.tipo}: ${String((r.q.reason as { code?: string })?.code ?? r.q.reason)}`);
  expect(raros, "solo se admite el rechazo por cupo o por archivado (nunca 40P01 ni otro error)").toEqual([]);
};

const ok = (res: Resultado[], tipo?: string) =>
  res.filter((r) => r.q.status === "fulfilled" && (tipo === undefined || r.tipo === tipo));
const delta = (res: Resultado[]) => ok(res).reduce((s, r) => s + (r.q as PromiseFulfilledResult<number>).value, 0);

// =================================================================================================
describe("conteo de activos: contarRucs y usoDelEstudio ignoran archivados (D4, CA-2)", () => {
  it("contarRucs cuenta solo los activos (numero) y no los de otro estudio", async () => {
    const e = await estudio(10, 4, 3);
    const otro = await estudio(10, 6, 2);
    const db = dbDe("contapp_backend", 2);
    const n = await db.withTenant({ tenantId: e.x.id }, (tx) => contarRucs(tx, e.x.id));
    expect(n).toBe(4);
    expect(typeof n).toBe("number");
    expect(await totalDe(e.x.id), "los archivados siguen en la tabla").toBe(7);
    expect(await db.withTenant({ tenantId: otro.x.id }, (tx) => contarRucs(tx, otro.x.id))).toBe(6);
  });

  it("usoDelEstudio.rucsUsados cuenta solo los activos y coincide con contarRucs (/plan/uso)", async () => {
    const e = await estudio(10, 3, 4);
    const db = dbDe("contapp_backend", 2);
    const [uso, n] = await db.withTenant({ tenantId: e.x.id }, async (tx) => [await usoDelEstudio(tx, e.x.id), await contarRucs(tx, e.x.id)] as const);
    expect(uso?.rucsUsados).toBe(3);
    expect(n).toBe(3);
  });

  it("archivar libera el cupo y reactivar lo vuelve a ocupar", async () => {
    const e = await estudio(10, 5);
    const db = dbDe("contapp_backend", 2);
    const contar = () => db.withTenant({ tenantId: e.x.id }, (tx) => contarRucs(tx, e.x.id));
    expect(await contar()).toBe(5);
    await archivarAdmin(e.activos.slice(0, 2));
    expect(await contar()).toBe(3);
    await reactivarAdmin(e.activos.slice(0, 1));
    expect(await contar()).toBe(4);
    await archivarAdmin(e.activos);
    expect(await contar(), "todos archivados").toBe(0);
  });

  it("estudio con todos sus clientes archivados: uso = 0 y quedan los cupos completos", async () => {
    const e = await estudio(5, 0, 5);
    const db = dbDe("contapp_backend", 2);
    const uso = await db.withTenant({ tenantId: e.x.id }, (tx) => usoDelEstudio(tx, e.x.id));
    expect(uso?.rucsUsados).toBe(0);
  });
});

// =================================================================================================
describe("cupo con archivados (CA-2): sin cupo no entra nada; archivar libera; reactivar vuelve a pedir cupo", () => {
  it("con el cupo lleno: crear y reactivar dan rechazo de cupo y no escriben nada; tras archivar uno, crear entra y reactivar vuelve a fallar", async () => {
    const e = await estudio(3, 3, 1);
    const db = dbDe("contapp_backend", 4);
    const actor = e.miembros[1]!.id;
    const antes = { total: await totalDe(e.x.id), activos: await activosDe(e.x.id) };
    await expect(crear(db, e, actor)).rejects.toBeInstanceOf(CupoLleno);
    await expect(reactivar(db, e, actor, e.archivados[0]!)).rejects.toBeInstanceOf(CupoLleno);
    expect({ total: await totalDe(e.x.id), activos: await activosDe(e.x.id) }, "no se escribio nada").toEqual(antes);

    expect(await archivar(db, e, e.activos[0]!)).toBe(-1);
    expect(await activosDe(e.x.id)).toBe(2);
    expect(await crear(db, e, actor)).toBe(1);
    expect(await activosDe(e.x.id)).toBe(3);
    await expect(reactivar(db, e, actor, e.archivados[0]!)).rejects.toBeInstanceOf(CupoLleno);
    expect(await activosDe(e.x.id)).toBe(3);
  });

  it("archivar es idempotente: el segundo archivado no cambia nada", async () => {
    const e = await estudio(5, 2);
    const db = dbDe("contapp_backend", 2);
    expect(await archivar(db, e, e.activos[0]!)).toBe(-1);
    expect(await archivar(db, e, e.activos[0]!)).toBe(0);
    expect(await activosDe(e.x.id)).toBe(1);
  });

  it("el rechazo por cupo no deja a medias la asignacion del responsable (todo o nada)", async () => {
    const e = await estudio(2, 2);
    const db = dbDe("contapp_backend", 2);
    const actor = e.miembros[1]!.id;
    await expect(crear(db, e, actor)).rejects.toBeInstanceOf(CupoLleno);
    const n = (await adm("select count(*)::int n from asignacion where tenant_id = $1 and usuario_id = $2", [e.x.id, actor]))[0].n;
    expect(n).toBe(0);
  });
});

// =================================================================================================
describe("revalidarEncolado con clientes archivados (D5, CA-5)", () => {
  const TODOS = ["dueno", "admin", "contador", "asistente", "lectura"];
  let x: string;
  let otroEstudio: string;
  let dueno: string;
  let contador: string;
  const worker = () => dbDe("contapp_worker", 3);
  const rev = (t: string, a: { clienteId: string; creadoPor: string | null; rolesPermitidos: string[] | null }) =>
    worker().withTenant({ tenantId: t }, (tx) => revalidarEncolado(tx, a));

  beforeAll(async () => {
    x = (await ep.ea.estudio()).id;
    otroEstudio = (await ep.ea.estudio()).id;
    dueno = (await ep.ea.miembro(x, "dueno")).id;
    contador = (await ep.ea.miembro(x, "contador")).id;
  });

  /** Cliente propio del caso, asignado al contador; `creadoPor` segun el caso. */
  async function clienteDe(creadoPor: "dueno" | "contador" | "programado") {
    const id = await ep.ea.cliente(x);
    await ep.ea.asignar(x, id, contador, "colaborador");
    const args = (roles: string[] | null) => ({
      clienteId: id,
      creadoPor: creadoPor === "programado" ? null : creadoPor === "dueno" ? dueno : contador,
      rolesPermitidos: roles,
    });
    return { id, args };
  }

  it.each(["dueno", "contador", "programado"] as const)(
    "creado por %s: 'ok' mientras esta activo, 'acceso_retirado' si se archiva y 'ok' de nuevo al reactivarlo",
    async (quien) => {
      const c = await clienteDe(quien);
      expect(await rev(x, c.args(TODOS)), "control: activo").toBe("ok");
      await archivarAdmin([c.id]);
      expect(await rev(x, c.args(TODOS)), "archivado").toBe("acceso_retirado");
      await reactivarAdmin([c.id]);
      expect(await rev(x, c.args(TODOS)), "reactivado").toBe("ok");
    },
  );

  it("el caso programado (creadoPor null) tambien queda retirado al archivar, con o sin roles requeridos", async () => {
    const c = await clienteDe("programado");
    await archivarAdmin([c.id]);
    expect(await rev(x, c.args(null))).toBe("acceso_retirado");
    expect(await rev(x, c.args(["dueno"]))).toBe("acceso_retirado");
  });

  it("archivar un cliente no afecta a otro del mismo estudio ni a uno de otro estudio", async () => {
    const a = await clienteDe("dueno");
    const b = await clienteDe("dueno");
    const ajeno = await ep.ea.cliente(otroEstudio);
    await archivarAdmin([a.id]);
    expect(await rev(x, a.args(TODOS))).toBe("acceso_retirado");
    expect(await rev(x, b.args(TODOS))).toBe("ok");
    expect(await rev(otroEstudio, { clienteId: ajeno, creadoPor: null, rolesPermitidos: null })).toBe("ok");
  });

  it("archivar tambien retira al creador con acceso global (el Dueño no 've' un archivado)", async () => {
    const c = await clienteDe("dueno");
    await archivarAdmin([c.id]);
    expect(await rev(x, c.args(["dueno", "admin"]))).toBe("acceso_retirado");
  });

  it("un trabajo vivo del cliente archivado se descarta aunque el creador conserve su membresia y asignacion", async () => {
    const c = await clienteDe("contador");
    await archivarAdmin([c.id]);
    const m = await adm("select 1 from membresia where usuario_id = $1 and desactivada_en is null", [contador]);
    const a = await adm("select 1 from asignacion where cliente_id = $1 and usuario_id = $2", [c.id, contador]);
    expect([m.length, a.length], "el acceso del usuario sigue intacto: solo cambia el cliente").toEqual([1, 1]);
    expect(await rev(x, c.args(TODOS))).toBe("acceso_retirado");
  });
});

// =================================================================================================
describe("carreras con dos o mas conexiones: crear, archivar, reactivar y asignar (CA-2, CA-7; D4)", () => {
  it.each([1, 2, 3, 4])(
    "ronda %i: 5 altas simultaneas con UN cupo libre -> entra exactamente una; activos <= maximo y los demas reciben rechazo de cupo",
    async () => {
      const e = await estudio(6, 5);
      const res = await correr(
        Array.from({ length: 5 }, (_, i) => ({ tipo: "crear", ir: (db: ContappDb) => crear(db, e, e.miembros[i % e.miembros.length]!.id) })),
      );
      sinOtrosErrores(res);
      expect(ok(res)).toHaveLength(1);
      expect(await activosDe(e.x.id)).toBe(6);
      expect(await totalDe(e.x.id)).toBe(6);
    },
  );

  it.each([1, 2, 3, 4])(
    "ronda %i: 2 altas + 3 reactivaciones con UN cupo libre -> entra exactamente uno de los cinco",
    async () => {
      const e = await estudio(6, 5, 3);
      const res = await correr([
        ...[0, 1].map((i) => ({ tipo: "crear", ir: (db: ContappDb) => crear(db, e, e.miembros[i]!.id) })),
        ...e.archivados.map((id, i) => ({ tipo: "reactivar", ir: (db: ContappDb) => reactivar(db, e, e.miembros[(i + 2) % 4]!.id, id) })),
      ]);
      sinOtrosErrores(res);
      expect(ok(res)).toHaveLength(1);
      expect(await activosDe(e.x.id)).toBe(6);
    },
  );

  it("sin cupo libre, ninguna alta ni reactivacion entra", async () => {
    const e = await estudio(5, 5, 2);
    const res = await correr([
      { tipo: "crear", ir: (db) => crear(db, e, e.miembros[0]!.id) },
      { tipo: "crear", ir: (db) => crear(db, e, e.miembros[1]!.id) },
      ...e.archivados.map((id, i) => ({ tipo: "reactivar", ir: (db: ContappDb) => reactivar(db, e, e.miembros[i + 2]!.id, id) })),
    ]);
    sinOtrosErrores(res);
    expect(ok(res)).toHaveLength(0);
    expect(await activosDe(e.x.id)).toBe(5);
    expect(await totalDe(e.x.id)).toBe(7);
  });

  it.each([1, 2, 3, 4])(
    "ronda %i: altas + reactivaciones + archivados a la vez -> los activos nunca exceden el limite y la cuenta cuadra",
    async () => {
      const e = await estudio(5, 5, 2);
      const res = await correr([
        ...e.activos.slice(0, 2).map((id) => ({ tipo: "archivar", ir: (db: ContappDb) => archivar(db, e, id) })),
        ...e.archivados.map((id, i) => ({ tipo: "reactivar", ir: (db: ContappDb) => reactivar(db, e, e.miembros[i]!.id, id) })),
        ...[2, 3].map((i) => ({ tipo: "crear", ir: (db: ContappDb) => crear(db, e, e.miembros[i]!.id) })),
      ]);
      sinOtrosErrores(res);
      const activos = await activosDe(e.x.id);
      expect(activos, "activos <= maximo").toBeLessThanOrEqual(e.max);
      expect(activos, "inicial + altas + reactivaciones - archivados").toBe(5 + delta(res));
      expect(ok(res, "archivar")).toHaveLength(2); // archivar nunca espera ni falla por cupo
    },
  );

  it.each([1, 2, 3, 4, 5])(
    "ronda %i: archivar + reactivar + asignar sobre los mismos clientes, sin interbloqueo (40P01) y con la cuenta cuadrada",
    async () => {
      const e = await estudio(12, 3, 3);
      const todos = [...e.activos, ...e.archivados];
      const flujos: Flujo[] = [];
      todos.forEach((id, i) => {
        flujos.push({ tipo: "archivar", ir: (db) => archivar(db, e, id) });
        flujos.push({ tipo: "reactivar", ir: (db) => reactivar(db, e, e.miembros[i % 4]!.id, id) });
        flujos.push({ tipo: "asignar", ir: (db) => asignar(db, e, e.miembros[(i + 1) % 4]!.id, e.miembros[(i + 2) % 4]!.id, id) });
      });
      const res = await correr(flujos);
      sinOtrosErrores(res);
      const activos = await activosDe(e.x.id);
      expect(activos).toBeLessThanOrEqual(e.max);
      expect(activos, "inicial + reactivaciones - archivados").toBe(3 + delta(res));
      expect(await totalDe(e.x.id), "ninguna operacion borra ni duplica clientes").toBe(6);
    },
  );

  it("asignar y archivar el mismo cliente a la vez no se bloquean entre si (el archivado solo toca `cliente`)", async () => {
    const e = await estudio(5, 2);
    const res = await correr([
      { tipo: "asignar", ir: (db) => asignar(db, e, e.miembros[0]!.id, e.miembros[1]!.id, e.activos[0]!) },
      { tipo: "archivar", ir: (db) => archivar(db, e, e.activos[0]!) },
      { tipo: "asignar", ir: (db) => asignar(db, e, e.miembros[2]!.id, e.miembros[3]!.id, e.activos[0]!) },
    ]);
    sinOtrosErrores(res);
    expect(ok(res, "archivar")).toHaveLength(1);
    expect(await activosDe(e.x.id)).toBe(1);
  });
});

// =================================================================================================
describe("RUC repetido en carrera (CA-2, D4): un solo ganador, el resto 23505, sin 40P01 ni cupo consumido", () => {
  const codigo = (r: PromiseSettledResult<number>) => (r.status === "rejected" ? String((r.reason as { code?: string })?.code) : "ok");

  it.each([1, 2, 3])("ronda %i: 5 altas con el mismo RUC y cupo de sobra -> una entra y las demas dan 23505", async () => {
    const e = await estudio(20, 2);
    const ruc = rucNuevo();
    const res = await correr(Array.from({ length: 5 }, (_, i) => ({ tipo: "crear", ir: (db: ContappDb) => crear(db, e, e.miembros[i % 4]!.id, ruc) })));
    expect(res.map((r) => codigo(r.q)).sort()).toEqual(["23505", "23505", "23505", "23505", "ok"]);
    expect((await adm("select count(*)::int n from cliente where tenant_id = $1 and ruc = $2", [e.x.id, ruc]))[0].n).toBe(1);
    expect(await activosDe(e.x.id), "el cupo solo lo consume el ganador").toBe(3);
  });

  it("sin pasar por el bloqueo de cupo (insercion directa concurrente) tambien hay un solo ganador y ningun 40P01", async () => {
    const e = await estudio(20, 1);
    const ruc = rucNuevo();
    const db = dbDe("contapp_backend", 8);
    const directo = () =>
      db.withTenant({ tenantId: e.x.id }, async (tx) => {
        await tx.query("insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, 'Directo')", [e.x.id, ruc]);
        await pausa(tx, 150);
        return 1;
      });
    const r = await Promise.allSettled([directo(), dormir(20).then(directo), dormir(40).then(directo), dormir(60).then(directo)]);
    expect(r.map(codigo).sort()).toEqual(["23505", "23505", "23505", "ok"]);
    expect((await adm("select count(*)::int n from cliente where tenant_id = $1 and ruc = $2", [e.x.id, ruc]))[0].n).toBe(1);
  });

  it("un RUC de un cliente archivado sigue ocupado: crear da 23505 (no se reutiliza) y no consume cupo", async () => {
    const e = await estudio(5, 2, 1);
    const ruc = (await adm("select ruc from cliente where id = $1", [e.archivados[0]]))[0].ruc as string;
    const db = dbDe("contapp_backend", 2);
    const r = await Promise.allSettled([crear(db, e, e.miembros[0]!.id, ruc)]);
    expect(codigo(r[0]!)).toBe("23505");
    expect(await activosDe(e.x.id)).toBe(2);
    expect(await totalDe(e.x.id)).toBe(3);
  });

  it("crear con RUC repetido y cupo lleno: gana el rechazo de cupo (se reserva antes de insertar) y no se escribe nada", async () => {
    const e = await estudio(2, 2);
    const ruc = (await adm("select ruc from cliente where id = $1", [e.activos[0]]))[0].ruc as string;
    const db = dbDe("contapp_backend", 2);
    await expect(crear(db, e, e.miembros[0]!.id, ruc)).rejects.toBeInstanceOf(CupoLleno);
    expect(await totalDe(e.x.id)).toBe(2);
  });
});
