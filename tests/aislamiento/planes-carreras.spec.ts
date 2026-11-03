// Spec 006 (T1, rojo): repos de cupo de packages/db y carreras de cupo con conexiones separadas (CA-5, CA-6, CA-7; D4, D6, D7;
// plan.md "Orden de bloqueo"). Sin HTTP: cada flujo replica el orden que fija el plan sobre los repos reales de 005.
//
// Contrato que fija (T5, packages/db/src/planes/cupo.ts, exportado desde @contapp/db). Todas reciben la `tx` de withTenant:
//   bloquearCupo(tx, tenantId): Promise<void>
//       pg_advisory_xact_lock(hashtextextended('plan.cupo:' || tenantId, 0)); dura hasta el commit/rollback de la transaccion.
//       Es el MISMO bloqueo que toma auth.cupo_usuarios_aceptar. Un solo bloqueo por estudio para usuarios y RUCs.
//   contarUsuarios(tx, tenantId): Promise<{ activos: number; pendientes: number }>   (D7: membresias con desactivada_en NULL;
//       invitaciones sin aceptar, sin revocar y con vence_en > now())
//   contarRucs(tx, tenantId): Promise<number>   (hoy todas las filas de `cliente` del estudio; 007 pasa a activos)
// Orden de bloqueo: (1) membresias que la accion toca -> (2') bloquearCupo -> (3) cliente -> (4) invitacion.
//   Invitar: bloquearMiembros([actor]) -> bloquearCupo -> contar -> crearInvitacion.
//   Reactivar: bloquearMiembros([actor, objetivo]) -> bloquearCupo -> contar -> reactivar.
//   Aceptar: auth.cupo_usuarios_aceptar -> auth.invitacion_aceptar_nueva (misma transaccion).
//   Importar: bloquearCupo -> contarRucs -> insertar clientes.
// Sin reintentos de 40P01: cualquier interbloqueo hace fallar la prueba.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirAdmin,
  abrirApp,
  crearDb,
  exportado,
  hashFalso,
  llamar,
} from "./auth-soporte";
import { EscenarioPlanes, tokenHashNuevo } from "./planes-soporte";
import type { ContappDb, Tx } from "./soporte";
import { tenantDe } from "./soporte";

type Bloquear = (tx: Tx, tenantId: string) => Promise<void>;
type ContarUsuarios = (
  tx: Tx,
  tenantId: string,
) => Promise<{ activos: number; pendientes: number }>;
type ContarRucs = (tx: Tx, tenantId: string) => Promise<number>;
const bloquearCupo: Bloquear = (tx, t) =>
  exportado<Bloquear>("bloquearCupo")(tx, t);
const contarUsuarios: ContarUsuarios = (tx, t) =>
  exportado<ContarUsuarios>("contarUsuarios")(tx, t);
const contarRucs: ContarRucs = (tx, t) =>
  exportado<ContarRucs>("contarRucs")(tx, t);
// Repos de 005 (ya existen): se usan tal cual, como los llamaran los servicios.
const bloquearMiembros = (tx: Tx, ids: string[]) =>
  exportado<(tx: Tx, ids: string[]) => Promise<unknown>>("bloquearMiembros")(
    tx,
    ids,
  );
const reactivarMiembro = (tx: Tx, id: string) =>
  exportado<(tx: Tx, id: string) => Promise<unknown>>("reactivar")(tx, id);
const crearInvitacion = (
  tx: Tx,
  n: { correo: string; rol: string; invitadoPor: string; tokenHash: Buffer },
) =>
  exportado<(tx: Tx, n: unknown) => Promise<unknown>>("crearInvitacion")(tx, n);

let app: Pool;
let admin: Pool;
let ep: EscenarioPlanes;
const dbs: ContappDb[] = [];

beforeAll(() => {
  app = abrirApp(30);
  admin = abrirAdmin(6);
  ep = new EscenarioPlanes(admin);
});
afterAll(async () => {
  await ep?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await app?.end();
  await admin?.end();
});

const dbBackend = (max = 14): ContappDb => {
  const d = crearDb("contapp_backend", max);
  dbs.push(d);
  return d;
};
const adm = async (sql: string, v: unknown[] = []) =>
  (await admin.query(sql, v)).rows;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pausa = (tx: Tx, ms: number) =>
  tx.query("select pg_sleep($1::float8)", [ms / 1000]);
class CupoLleno extends Error {}
const CUPO = "select auth.cupo_usuarios_aceptar($1::uuid) as v";

/** Toma el bloqueo de cupo del estudio y lo sostiene `ms`; `adquirido` resuelve con la hora en que lo obtuvo. */
function sostener(db: ContappDb, tenantId: string, ms: number) {
  let resolver!: (t: number) => void;
  const adquirido = new Promise<number>((r) => (resolver = r));
  const terminado = db.withTenant({ tenantId }, async (tx) => {
    await bloquearCupo(tx, tenantId);
    resolver(Date.now());
    await pausa(tx, ms);
  });
  // Si el bloqueo no existe aun (rojo), `adquirido` nunca resuelve: se rechaza para no colgar la prueba.
  terminado.catch(() => undefined);
  return {
    adquirido: Promise.race([
      adquirido,
      terminado.then(() => Promise.reject(new Error("no tomo el bloqueo"))),
    ]),
    terminado,
  };
}

/** Intenta el mismo advisory lock desde otra conexion: false si alguien lo tiene. */
async function bloqueoLibre(tenantId: string): Promise<boolean> {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    return (
      await c.query(
        "select pg_try_advisory_xact_lock(hashtextextended('plan.cupo:' || $1::text, 0)) as v",
        [tenantId],
      )
    ).rows[0].v as boolean;
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

// =================================================================================================
describe("repos de cupo de packages/db: contarUsuarios, contarRucs y bloquearCupo (D4, D7)", () => {
  it("contarUsuarios: activos = membresias activas (el Dueño cuenta); pendientes = invitaciones vigentes; no cuentan desactivados, vencidas, revocadas ni aceptadas", async () => {
    const p = await ep.plan();
    const { x, dueno } = await ep.estudioConUsuarios(p.id, {
      activos: 3,
      desactivados: 2,
      pendientes: 2,
      vencidas: 1,
    });
    await ep.ea.invitacion(x.id, { invitadoPor: dueno.id, revocada: true });
    await ep.ea.invitacion(x.id, { invitadoPor: dueno.id, aceptada: true });
    const r = await dbBackend(2).withTenant({ tenantId: x.id }, (tx) =>
      contarUsuarios(tx, x.id),
    );
    expect(r).toEqual({ activos: 3, pendientes: 2 });
    expect(typeof r.activos).toBe("number");
    expect(typeof r.pendientes).toBe("number");
  });

  it("contarUsuarios de un estudio sin miembros ni invitaciones devuelve ceros", async () => {
    const x = await ep.estudioConPlan((await ep.plan()).id);
    expect(
      await dbBackend(2).withTenant({ tenantId: x.id }, (tx) =>
        contarUsuarios(tx, x.id),
      ),
    ).toEqual({ activos: 0, pendientes: 0 });
  });

  it("contarRucs cuenta las filas de cliente del estudio (numero) y nunca las de otro estudio", async () => {
    const p = await ep.plan();
    const x = await ep.estudioConPlan(p.id);
    const y = await ep.estudioConPlan(p.id);
    await ep.ea.clientes(x.id, 4);
    await ep.ea.clientes(y.id, 7);
    const db = dbBackend(2);
    const n = await db.withTenant({ tenantId: x.id }, (tx) =>
      contarRucs(tx, x.id),
    );
    expect(n).toBe(4);
    expect(typeof n).toBe("number");
    expect(
      await db.withTenant({ tenantId: y.id }, (tx) => contarRucs(tx, y.id)),
    ).toBe(7);
  });

  it("los conteos del seed coinciden con la BD (A y B tienen 3 clientes y su Dueño, sin cruzarse)", async () => {
    const db = dbBackend(2);
    for (const t of [tenantDe("A"), tenantDe("B")]) {
      expect(
        await db.withTenant({ tenantId: t }, (tx) => contarRucs(tx, t)),
      ).toBe(3);
      const esperado = (
        await adm(
          "select count(*)::int n from membresia where tenant_id = $1 and desactivada_en is null",
          [t],
        )
      )[0].n;
      expect(
        (await db.withTenant({ tenantId: t }, (tx) => contarUsuarios(tx, t)))
          .activos,
      ).toBe(esperado);
    }
  });

  it("bloquearCupo toma pg_advisory_xact_lock(hashtextextended('plan.cupo:' || estudio, 0)) hasta el commit, y solo el de ese estudio", async () => {
    const x = await ep.estudioConPlan((await ep.plan()).id);
    const otro = await ep.estudioConPlan((await ep.plan()).id);
    const s = sostener(dbBackend(2), x.id, 500);
    await s.adquirido;
    expect(
      await bloqueoLibre(x.id),
      "mientras la transaccion sigue abierta",
    ).toBe(false);
    expect(await bloqueoLibre(otro.id), "otro estudio no se ve afectado").toBe(
      true,
    );
    await s.terminado;
    expect(await bloqueoLibre(x.id), "tras el commit").toBe(true);
  });

  it("el bloqueo tambien se libera con un rollback", async () => {
    const x = await ep.estudioConPlan((await ep.plan()).id);
    await dbBackend(2)
      .withTenant({ tenantId: x.id }, async (tx) => {
        await bloquearCupo(tx, x.id);
        throw new CupoLleno();
      })
      .catch(() => undefined);
    expect(await bloqueoLibre(x.id)).toBe(true);
  });
});

// =================================================================================================
describe("serializacion del bloqueo de cupo (D4)", () => {
  it("dos bloquearCupo del mismo estudio se serializan: el segundo espera el commit del primero", async () => {
    const x = await ep.estudioConPlan((await ep.plan()).id);
    const db = dbBackend(4);
    const primero = sostener(db, x.id, 700);
    const t0 = await primero.adquirido;
    const t1 = await db.withTenant({ tenantId: x.id }, async (tx) => {
      await bloquearCupo(tx, x.id);
      return Date.now();
    });
    await primero.terminado;
    expect(
      t1 - t0,
      "el segundo obtuvo el bloqueo antes de que el primero terminara",
    ).toBeGreaterThanOrEqual(600);
  });

  it("de estudios distintos NO se serializan", async () => {
    const x = await ep.estudioConPlan((await ep.plan()).id);
    const y = await ep.estudioConPlan((await ep.plan()).id);
    const db = dbBackend(4);
    const primero = sostener(db, x.id, 800);
    const t0 = await primero.adquirido;
    const t1 = await db.withTenant({ tenantId: y.id }, async (tx) => {
      await bloquearCupo(tx, y.id);
      return Date.now();
    });
    expect(t1 - t0, "el bloqueo de otro estudio no debe esperar").toBeLessThan(
      400,
    );
    await primero.terminado;
  });

  it("auth.cupo_usuarios_aceptar usa el MISMO bloqueo: espera a quien lo tiene y no espera por otro estudio", async () => {
    const p = await ep.plan({ maxUsuarios: 5 });
    const { x } = await ep.estudioConUsuarios(p.id, { activos: 1 });
    const { x: y } = await ep.estudioConUsuarios(p.id, { activos: 1 });
    const db = dbBackend(4);
    const primero = sostener(db, x.id, 800);
    const t0 = await primero.adquirido;
    const enOtro = await llamar(app, CUPO, [y.id]);
    expect(enOtro.ok && enOtro.rows[0].v).toBe(true);
    expect(Date.now() - t0, "otro estudio no espera").toBeLessThan(400);
    const r = await llamar(app, CUPO, [x.id]);
    const t1 = Date.now();
    expect(r.ok && r.rows[0].v).toBe(true);
    expect(
      t1 - t0,
      "el mismo estudio espera al que tiene el bloqueo",
    ).toBeGreaterThanOrEqual(650);
    await primero.terminado;
  });
});

// =================================================================================================
describe("carrera de invitar + reactivar + aceptar con pocos cupos libres (CA-6, D7: activos + pendientes <= max, sin 40P01)", () => {
  interface Cupo {
    x: { id: string };
    dueno: { id: string };
    admin2: { id: string };
    desactivados: { id: string }[];
    invitacion: { tokenHash: Buffer };
    max: number;
  }

  /** 2 activos (Dueño y otro) + 1 invitacion pendiente = 3 contados; `libres` cupos libres; 3 desactivados reactivables. */
  async function escenario(libres: number): Promise<Cupo> {
    const max = 3 + libres;
    const p = await ep.plan({ maxUsuarios: max });
    const e = await ep.estudioConUsuarios(p.id, {
      activos: 2,
      desactivados: 3,
      pendientes: 1,
    });
    return {
      x: e.x,
      dueno: e.dueno,
      admin2: e.miembros[1]!,
      desactivados: e.desactivados,
      invitacion: e.invitaciones[0]!,
      max,
    };
  }

  const invitar = (db: ContappDb, e: Cupo, actor: string, correo: string) =>
    db.withTenant({ tenantId: e.x.id, userId: actor }, async (tx) => {
      await bloquearMiembros(tx, [actor]);
      await bloquearCupo(tx, e.x.id);
      const { activos, pendientes } = await contarUsuarios(tx, e.x.id);
      if (activos + pendientes + 1 > e.max) throw new CupoLleno();
      await crearInvitacion(tx, {
        correo,
        rol: "contador",
        invitadoPor: actor,
        tokenHash: tokenHashNuevo(),
      });
      await pausa(tx, 120); // mantiene abierta la transaccion para forzar el solape
    });

  const reactivar = (db: ContappDb, e: Cupo, actor: string, objetivo: string) =>
    db.withTenant({ tenantId: e.x.id, userId: actor }, async (tx) => {
      await bloquearMiembros(tx, [actor, objetivo]);
      await bloquearCupo(tx, e.x.id);
      const { activos, pendientes } = await contarUsuarios(tx, e.x.id);
      if (activos + pendientes + 1 > e.max) throw new CupoLleno();
      await reactivarMiembro(tx, objetivo);
      await pausa(tx, 120);
    });

  async function aceptar(e: Cupo): Promise<void> {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE contapp_backend");
      if ((await c.query(CUPO, [e.x.id])).rows[0].v !== true)
        throw new CupoLleno();
      const r = (
        await c.query(
          "select auth.invitacion_aceptar_nueva($1::bytea, $2::text, $3::text) as v",
          [e.invitacion.tokenHash, "Persona Invitada", hashFalso()],
        )
      ).rows[0].v;
      if (r !== "aceptada")
        throw new Error(`la aceptacion devolvio ${String(r)}`);
      await c.query("select pg_sleep(0.12)");
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  const totales = async (t: string) =>
    (
      await adm(
        `select (select count(*) from membresia where tenant_id = $1 and desactivada_en is null)::int activos,
                (select count(*) from invitacion where tenant_id = $1 and aceptada_en is null and revocada_en is null and vence_en > now())::int pendientes`,
        [t],
      )
    )[0] as { activos: number; pendientes: number };

  /** Lanza todo a la vez (con un desfase corto distinto por flujo) y devuelve los resultados. */
  async function correr(
    e: Cupo,
    flujos: Array<{ tipo: string; ir: (db: ContappDb) => Promise<void> }>,
  ) {
    const db = dbBackend(flujos.length + 2);
    const orden = [...flujos].sort(() => Math.random() - 0.5);
    const r = await Promise.allSettled(
      orden.map((f, i) => dormir(i * 25).then(() => f.ir(db))),
    );
    return r.map((q, i) => ({ tipo: orden[i]!.tipo, q }));
  }

  const sinOtrosErrores = (res: Awaited<ReturnType<typeof correr>>) => {
    const raros = res
      .filter(
        (r) =>
          r.q.status === "rejected" &&
          !((r.q as PromiseRejectedResult).reason instanceof CupoLleno),
      )
      .map(
        (r) =>
          `${r.tipo}: ${String(((r.q as PromiseRejectedResult).reason as { code?: string; message?: string })?.code ?? (r.q as PromiseRejectedResult).reason)}`,
      );
    expect(
      raros,
      "solo se admite el rechazo por cupo (nunca 40P01 ni otro error)",
    ).toEqual([]);
  };

  it.each([1, 2, 3, 4, 5])(
    "ronda %i: 2 invitaciones + 3 reactivaciones + 1 aceptacion con UN cupo libre -> entra exactamente uno de los que agregan, la aceptacion siempre pasa",
    async () => {
      const e = await escenario(1);
      const res = await correr(e, [
        {
          tipo: "invitar",
          ir: (db) => invitar(db, e, e.dueno.id, ep.ea.esc.correoNuevo()),
        },
        {
          tipo: "invitar",
          ir: (db) => invitar(db, e, e.admin2.id, ep.ea.esc.correoNuevo()),
        },
        ...e.desactivados.map((d) => ({
          tipo: "reactivar",
          ir: (db: ContappDb) => reactivar(db, e, e.dueno.id, d.id),
        })),
        { tipo: "aceptar", ir: () => aceptar(e) },
      ]);
      sinOtrosErrores(res);
      const agregan = res.filter((r) => r.tipo !== "aceptar");
      expect(
        agregan.filter((r) => r.q.status === "fulfilled"),
        "los que agregan y lo lograron",
      ).toHaveLength(1);
      expect(res.find((r) => r.tipo === "aceptar")!.q.status).toBe("fulfilled");
      const t = await totales(e.x.id);
      expect(t.activos + t.pendientes).toBeLessThanOrEqual(e.max);
      expect(t.activos + t.pendientes).toBe(e.max);
    },
  );

  it.each([1, 2, 3])(
    "ronda %i: 3 invitaciones + 3 reactivaciones + 1 aceptacion con DOS cupos libres -> entran exactamente dos",
    async () => {
      const e = await escenario(2);
      const res = await correr(e, [
        ...[0, 1, 2].map(() => ({
          tipo: "invitar",
          ir: (db: ContappDb) =>
            invitar(db, e, e.dueno.id, ep.ea.esc.correoNuevo()),
        })),
        ...e.desactivados.map((d) => ({
          tipo: "reactivar",
          ir: (db: ContappDb) => reactivar(db, e, e.admin2.id, d.id),
        })),
        { tipo: "aceptar", ir: () => aceptar(e) },
      ]);
      sinOtrosErrores(res);
      expect(
        res.filter((r) => r.tipo !== "aceptar" && r.q.status === "fulfilled"),
      ).toHaveLength(2);
      expect(res.find((r) => r.tipo === "aceptar")!.q.status).toBe("fulfilled");
      const t = await totales(e.x.id);
      expect(t.activos + t.pendientes).toBe(e.max);
    },
  );

  it("diez invitaciones simultaneas con un solo cupo libre: se crea una", async () => {
    const e = await escenario(1);
    const res = await correr(
      e,
      // actores alternados: con uno solo, el FOR UPDATE de su membresia ya los serializaria sin el bloqueo de cupo
      Array.from({ length: 10 }, (_, i) => ({
        tipo: "invitar",
        ir: (db: ContappDb) =>
          invitar(
            db,
            e,
            i % 2 === 0 ? e.dueno.id : e.admin2.id,
            ep.ea.esc.correoNuevo(),
          ),
      })),
    );
    sinOtrosErrores(res);
    expect(res.filter((r) => r.q.status === "fulfilled")).toHaveLength(1);
    expect((await totales(e.x.id)).pendientes).toBe(2); // la que ya habia + la nueva
  });

  it("sin cupo libre, ninguna invitacion ni reactivacion entra y la aceptacion de la ya contada sigue pasando", async () => {
    const e = await escenario(0);
    const res = await correr(e, [
      {
        tipo: "invitar",
        ir: (db) => invitar(db, e, e.dueno.id, ep.ea.esc.correoNuevo()),
      },
      {
        tipo: "reactivar",
        ir: (db) => reactivar(db, e, e.dueno.id, e.desactivados[0]!.id),
      },
      { tipo: "aceptar", ir: () => aceptar(e) },
    ]);
    sinOtrosErrores(res);
    expect(
      res.filter((r) => r.tipo !== "aceptar" && r.q.status === "fulfilled"),
    ).toHaveLength(0);
    expect(res.find((r) => r.tipo === "aceptar")!.q.status).toBe("fulfilled");
    expect(await totales(e.x.id)).toEqual({ activos: 3, pendientes: 0 });
  });

  it("CA-7: con el plan bajado por debajo del uso, aceptar se rechaza (false) y no se crea la membresia; nada se borra", async () => {
    const e = await escenario(1);
    await adm(
      "update plan set max_usuarios = 2 where id = (select plan_id from suscripcion where tenant_id = $1)",
      [e.x.id],
    );
    await expect(aceptar(e)).rejects.toBeInstanceOf(CupoLleno);
    expect(await totales(e.x.id)).toEqual({ activos: 2, pendientes: 1 });
  });
});

// =================================================================================================
describe("carrera de importaciones de RUCs con el mismo bloqueo (CA-5, D4, D6)", () => {
  const LIMITE = `select p.max_rucs + least(s.rucs_extra_contratados, p.max_rucs_extra) as limite
       from suscripcion s join plan p on p.id = s.plan_id`;

  const importar = (
    db: ContappDb,
    tenantId: string,
    n: number,
    prefijo: string,
  ) =>
    db.withTenant({ tenantId }, async (tx) => {
      await bloquearCupo(tx, tenantId);
      const limite = Number((await tx.query(LIMITE)).rows[0].limite);
      const usados = await contarRucs(tx, tenantId);
      if (usados + n > limite) throw new CupoLleno();
      await tx.query(
        `insert into cliente (tenant_id, ruc, razon_social)
         select $1, '2' || $2 || lpad(g::text, 5, '0'), 'Cliente importado ' || g from generate_series(1, $3::int) g`,
        [tenantId, prefijo, n],
      );
      await pausa(tx, 150);
    });

  const clientes = async (t: string) =>
    (
      await adm("select count(*)::int n from cliente where tenant_id = $1", [t])
    )[0].n as number;

  it("dos importaciones de 3 RUCs con limite 5: entra solo la que cabe (la otra recibe el rechazo de cupo)", async () => {
    const x = await ep.estudioConPlan(
      (await ep.plan({ maxRucs: 5, maxRucsExtra: 1 })).id,
    ); // 0 contratados -> limite 5
    const db = dbBackend(4);
    const r = await Promise.allSettled([
      importar(db, x.id, 3, "00001"),
      dormir(30).then(() => importar(db, x.id, 3, "00002")),
    ]);
    expect(r.filter((q) => q.status === "fulfilled")).toHaveLength(1);
    const rechazo = r.find(
      (q): q is PromiseRejectedResult => q.status === "rejected",
    );
    expect(rechazo?.reason).toBeInstanceOf(CupoLleno);
    expect(await clientes(x.id)).toBe(3);
  });

  it("el limite efectivo suma los adicionales contratados (max_rucs + min(contratados, tope)): con 1 contratado caben las dos", async () => {
    const x = await ep.estudioConPlan(
      (await ep.plan({ maxRucs: 5, maxRucsExtra: 1 })).id,
      { rucsExtra: 1 },
    ); // limite 6
    const db = dbBackend(4);
    const r = await Promise.allSettled([
      importar(db, x.id, 3, "00003"),
      dormir(30).then(() => importar(db, x.id, 3, "00004")),
    ]);
    expect(r.map((q) => q.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await clientes(x.id)).toBe(6);
  });

  it("los adicionales contratados por encima del tope del plan no dan cupo (min, D10): 4 contratados con tope 1 -> limite 6", async () => {
    const x = await ep.estudioConPlan(
      (await ep.plan({ maxRucs: 5, maxRucsExtra: 1 })).id,
      { rucsExtra: 4 },
    );
    const db = dbBackend(4);
    await importar(db, x.id, 6, "00005");
    await expect(importar(db, x.id, 1, "00006")).rejects.toBeInstanceOf(
      CupoLleno,
    );
    expect(await clientes(x.id)).toBe(6);
  });

  it("n = 1 con tres importaciones a la vez y justo un cupo libre: entra una", async () => {
    const x = await ep.estudioConPlan(
      (await ep.plan({ maxRucs: 5, maxRucsExtra: 0 })).id,
    );
    await ep.ea.clientes(x.id, 4);
    const db = dbBackend(6);
    const r = await Promise.allSettled([
      importar(db, x.id, 1, "00021"),
      importar(db, x.id, 1, "00022"),
      importar(db, x.id, 1, "00023"),
    ]);
    expect(r.filter((q) => q.status === "fulfilled")).toHaveLength(1);
    for (const q of r.filter(
      (q): q is PromiseRejectedResult => q.status === "rejected",
    ))
      expect(q.reason).toBeInstanceOf(CupoLleno);
    expect(await clientes(x.id)).toBe(5);
  });

  it("invitar y importar a la vez comparten el bloqueo sin interbloqueo (40P01): una invitacion y una importacion entran con un cupo libre de cada tipo", async () => {
    const p = await ep.plan({ maxRucs: 5, maxRucsExtra: 0, maxUsuarios: 3 });
    const { x, dueno } = await ep.estudioConUsuarios(p.id, { activos: 2 });
    await ep.ea.clientes(x.id, 4);
    const db = dbBackend(12);
    const invitar = (correo: string) =>
      db.withTenant({ tenantId: x.id, userId: dueno.id }, async (tx) => {
        await bloquearMiembros(tx, [dueno.id]);
        await bloquearCupo(tx, x.id);
        const { activos, pendientes } = await contarUsuarios(tx, x.id);
        if (activos + pendientes + 1 > 3) throw new CupoLleno();
        await crearInvitacion(tx, {
          correo,
          rol: "contador",
          invitadoPor: dueno.id,
          tokenHash: tokenHashNuevo(),
        });
        await pausa(tx, 100);
      });
    const flujos = [
      ...[0, 1, 2].map(() => ({
        tipo: "invitar",
        ir: () => invitar(ep.ea.esc.correoNuevo()),
      })),
      ...[0, 1, 2].map((i) => ({
        tipo: "importar",
        ir: () => importar(db, x.id, 1, `0003${i}`),
      })),
    ].sort(() => Math.random() - 0.5);
    const r = await Promise.allSettled(
      flujos.map((f, i) => dormir(i * 20).then(f.ir)),
    );
    const raros = r.filter(
      (q) =>
        q.status === "rejected" &&
        !((q as PromiseRejectedResult).reason instanceof CupoLleno),
    );
    expect(
      raros.map((q) =>
        String(((q as PromiseRejectedResult).reason as { code?: string }).code),
      ),
    ).toEqual([]);
    const ok = (tipo: string) =>
      r.filter((q, i) => flujos[i]!.tipo === tipo && q.status === "fulfilled")
        .length;
    expect(ok("invitar")).toBe(1);
    expect(ok("importar")).toBe(1);
    expect(await clientes(x.id)).toBe(5);
  });
});
