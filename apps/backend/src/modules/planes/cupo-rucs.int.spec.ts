/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas en pruebas */
// T3 (006) · CA-5 (límite de RUCs, D4, D6, D10) con el adaptador REAL y dos `withTenant` simultáneos del mismo estudio
// (sin HTTP: 007 aún no trae rutas de clientes). El llamador se comporta como lo hará 007: `reservar(n)` antes de
// insertar, el INSERT en la misma transacción, y el bloqueo dura hasta el commit. Hoy `cliente` no tiene estado:
// se cuentan todas las filas (D4). Rojo: plan, suscripción y adaptador aún no existen (T5, T7).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@contapp/db";
import { pausa } from "../../../test/soporte.js";
import { abrirBancoPlanes, type BancoPlanes, type PlanPrueba } from "../../../test/soporte-planes.js";
import { CupoRucsError, CupoRucsPlanes } from "./cupo/cupo-rucs.js";
import { PlanNoDisponibleError } from "./cupo/errores.js";

let p: BancoPlanes;
const cupo = new CupoRucsPlanes();
beforeAll(async () => {
  p = await abrirBancoPlanes();
});
afterAll(async () => {
  await p?.cerrar();
});

const usados = async (t: string) => Number((await p.sql("select count(*)::int n from cliente where tenant_id = $1", [t]))[0].n);
const dbTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => p.b.h.dbBackend.withTenant({ tenantId }, fn);
let serie = 0;
/** Inserta `n` clientes en la transacción del llamador (lo que hará 007 tras `reservar`). */
async function insertar(tx: Tx, tenantId: string, n: number): Promise<void> {
  const base = 10_000 + ++serie * 1000;
  await tx.query(
    `insert into cliente (tenant_id, ruc, razon_social)
     select $1, '20' || lpad((($2::int) + g)::text, 9, '0'), 'Cliente T3 ' || (($2::int) + g)
       from generate_series(1, $3::int) g`,
    [tenantId, base, n],
  );
}
/** Importación simulada: reserva, inserta y (opcional) retiene la transacción para forzar el solape. */
const importar = (tenantId: string, n: number, retener = 0) =>
  dbTenant(tenantId, async (tx) => {
    await cupo.reservar(tx, tenantId, n);
    if (retener > 0) await pausa(retener);
    await insertar(tx, tenantId, n);
    return n;
  });
const resultado = async (pr: Promise<unknown>): Promise<"ok" | "cupo_rucs" | "sin_plan" | string> => {
  try {
    await pr;
    return "ok";
  } catch (e) {
    if (e instanceof CupoRucsError) return "cupo_rucs";
    if (e instanceof PlanNoDisponibleError) return "sin_plan";
    return `otro: ${(e as Error).message}`;
  }
};
async function estudioCon(maxRucs: number, o: { extra?: number; tope?: number; plan?: Partial<{ maxUsuarios: number | null }> } = {}) {
  const plan: PlanPrueba = await p.plan({ maxRucs, maxRucsExtra: o.tope ?? 0, ...o.plan });
  const E = await p.estudio(plan, { rucsExtra: o.extra ?? 0 });
  return { E, plan };
}

describe("CA-5 · libres y reservar (límite efectivo = max_rucs + min(contratados, tope), D6, D10)", () => {
  it("libres cuenta las filas de cliente; con N cupos libres informa N", async () => {
    const { E } = await estudioCon(10);
    expect(await dbTenant(E.tenantId, (tx) => cupo.libres(tx, E.tenantId))).toBe(10);
    await p.b.clientes(E.tenantId, 4);
    expect(await dbTenant(E.tenantId, (tx) => cupo.libres(tx, E.tenantId))).toBe(6);
  });

  it("el límite suma los adicionales contratados hasta el tope del plan (D6, D10)", async () => {
    const { E, plan } = await estudioCon(20, { tope: 4, extra: 3 });
    await p.b.clientes(E.tenantId, 20);
    expect(await dbTenant(E.tenantId, (tx) => cupo.libres(tx, E.tenantId))).toBe(3);
    await p.editarPlan(plan, { max_rucs_extra: 1 }); // tope bajado: contratados 3 valen 1
    expect(await dbTenant(E.tenantId, (tx) => cupo.libres(tx, E.tenantId))).toBe(1);
    await p.fijarPlan(E.tenantId, plan, { rucsExtra: 0 });
    expect(await dbTenant(E.tenantId, (tx) => cupo.libres(tx, E.tenantId))).toBe(0);
  });

  it("reservar(n) rechaza con CupoRucsError si usados + n supera el límite y el borde entra", async () => {
    const { E } = await estudioCon(10);
    await p.b.clientes(E.tenantId, 7);
    expect(await resultado(dbTenant(E.tenantId, (tx) => cupo.reservar(tx, E.tenantId, 4)))).toBe("cupo_rucs");
    expect(await resultado(dbTenant(E.tenantId, (tx) => cupo.reservar(tx, E.tenantId, 3)))).toBe("ok");
    expect(await usados(E.tenantId)).toBe(7); // reservar no escribe
  });

  it("CupoRucsError es 409 cupo_rucs sin datos del plan", async () => {
    const { E } = await estudioCon(1);
    await p.b.clientes(E.tenantId, 1);
    try {
      await dbTenant(E.tenantId, (tx) => cupo.reservar(tx, E.tenantId, 1));
      expect.unreachable("debió rechazar");
    } catch (e: any) {
      expect(e).toBeInstanceOf(CupoRucsError);
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toEqual({ codigo: "cupo_rucs" });
    }
  });

  it("archivar libera el cupo en la consulta siguiente (hoy: borrar la fila)", async () => {
    const { E } = await estudioCon(5);
    await p.b.clientes(E.tenantId, 5);
    expect(await resultado(dbTenant(E.tenantId, (tx) => cupo.reservar(tx, E.tenantId, 1)))).toBe("cupo_rucs");
    await p.sql(
      "delete from cliente where id in (select id from cliente where tenant_id = $1 order by ruc limit 2)",
      [E.tenantId],
    );
    expect(await dbTenant(E.tenantId, (tx) => cupo.libres(tx, E.tenantId))).toBe(2);
    expect(await resultado(dbTenant(E.tenantId, (tx) => cupo.reservar(tx, E.tenantId, 2)))).toBe("ok");
  });

  it("CA-7: con el plan bajado por debajo del uso no se borra nada, libres es 0 y reservar rechaza", async () => {
    const { E, plan } = await estudioCon(10);
    await p.b.clientes(E.tenantId, 9);
    await p.editarPlan(plan, { max_rucs: 5 });
    expect(await usados(E.tenantId)).toBe(9);
    expect(await dbTenant(E.tenantId, (tx) => cupo.libres(tx, E.tenantId))).toBe(0);
    expect(await resultado(dbTenant(E.tenantId, (tx) => cupo.reservar(tx, E.tenantId, 1)))).toBe("cupo_rucs");
    expect(await usados(E.tenantId)).toBe(9);
  });

  it("sin suscripción falla cerrado: PlanNoDisponibleError (409 sin_plan), nunca 'sin límite'", async () => {
    const E = await p.estudio(null);
    expect(await resultado(dbTenant(E.tenantId, (tx) => cupo.libres(tx, E.tenantId)))).toBe("sin_plan");
    expect(await resultado(dbTenant(E.tenantId, (tx) => cupo.reservar(tx, E.tenantId, 1)))).toBe("sin_plan");
    const e = new PlanNoDisponibleError();
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({ codigo: "sin_plan" });
  });

  it("cuenta solo las filas del estudio: los clientes de otro estudio no consumen cupo (RLS)", async () => {
    const x = await estudioCon(5);
    const y = await estudioCon(5);
    await p.b.clientes(y.E.tenantId, 5);
    expect(await dbTenant(x.E.tenantId, (tx) => cupo.libres(tx, x.E.tenantId))).toBe(5);
  });

  it("CA-2: el límite se relee en cada llamada (cambiar el plan en BD cambia el resultado sin reiniciar)", async () => {
    const { E, plan } = await estudioCon(3);
    await p.b.clientes(E.tenantId, 3);
    expect(await resultado(dbTenant(E.tenantId, (tx) => cupo.reservar(tx, E.tenantId, 1)))).toBe("cupo_rucs");
    await p.editarPlan(plan, { max_rucs: 4 });
    expect(await resultado(dbTenant(E.tenantId, (tx) => cupo.reservar(tx, E.tenantId, 1)))).toBe("ok");
  });
});

describe("CA-5 · carreras: el bloqueo del cupo serializa importaciones del mismo estudio (D4)", () => {
  it("dos importaciones simultáneas que juntas superan el límite: entra solo la que cabe y el total no excede", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const { E } = await estudioCon(10);
      await p.b.clientes(E.tenantId, 2); // 8 libres
      const [a, b] = await Promise.all([resultado(importar(E.tenantId, 5, 150)), resultado(importar(E.tenantId, 5, 150))]);
      expect([a, b].sort(), `ronda ${ronda}`).toEqual(["cupo_rucs", "ok"]);
      expect(await usados(E.tenantId)).toBe(7);
    }
  });

  it("si caben las dos, entran las dos (el bloqueo serializa, no rechaza de más)", async () => {
    const { E } = await estudioCon(10);
    const rs = await Promise.all([resultado(importar(E.tenantId, 4, 100)), resultado(importar(E.tenantId, 6, 100))]);
    expect(rs).toEqual(["ok", "ok"]);
    expect(await usados(E.tenantId)).toBe(10);
  });

  it("seis importaciones de 2 a la vez con 7 libres: entran exactamente tres", async () => {
    const { E } = await estudioCon(7);
    const rs = await Promise.all(Array.from({ length: 6 }, () => resultado(importar(E.tenantId, 2, 60))));
    expect(rs.filter((r) => r === "ok")).toHaveLength(3);
    expect(rs.filter((r) => r === "cupo_rucs")).toHaveLength(3);
    expect(await usados(E.tenantId)).toBe(6);
  });

  it("libres + reservar simultáneos no se interbloquean y respetan el límite", async () => {
    const { E } = await estudioCon(4);
    const rs = await Promise.all([
      resultado(importar(E.tenantId, 3, 80)),
      resultado(dbTenant(E.tenantId, (tx) => cupo.libres(tx, E.tenantId))),
      resultado(importar(E.tenantId, 3, 80)),
    ]);
    expect(rs.filter((r) => r.startsWith("otro"))).toEqual([]);
    expect(rs.filter((r) => r === "ok").length).toBeGreaterThanOrEqual(2); // 1 importación + la consulta, o las dos consultas
    expect(await usados(E.tenantId)).toBe(3);
  });

  it("estudios distintos no se serializan: el segundo no espera la retención del primero", async () => {
    const x = await estudioCon(10);
    const y = await estudioCon(10);
    const t0 = Date.now();
    const lenta = resultado(importar(x.E.tenantId, 1, 900));
    await pausa(100);
    const t1 = Date.now();
    expect(await resultado(importar(y.E.tenantId, 1))).toBe("ok");
    expect(Date.now() - t1).toBeLessThan(600);
    expect(await lenta).toBe("ok");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it("mismo estudio: la segunda reserva espera hasta el commit de la primera", async () => {
    const { E } = await estudioCon(10);
    const t0 = Date.now();
    const primera = resultado(importar(E.tenantId, 1, 600));
    await pausa(100);
    const segunda = await resultado(importar(E.tenantId, 1));
    expect(segunda).toBe("ok");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(await primera).toBe("ok");
  });
});
