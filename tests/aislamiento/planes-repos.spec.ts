// Spec 006 (T11, cobertura): repos de planes de packages/db contra la BD real: leerLimites, usoDelEstudio y el error de
// los repos (solo SQLSTATE). Complementa planes-carreras.spec.ts (bloquearCupo, contarUsuarios, contarRucs).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, crearDb, exportado } from "./auth-soporte";
import { EscenarioPlanes } from "./planes-soporte";
import type { ContappDb, Tx } from "./soporte";

type Limites = {
  maxRucs: number;
  maxUsuarios: number | null;
  maxRucsExtra: number;
  rucsExtraContratados: number;
};
type Uso = Limites & {
  plan: { codigo: string; nombre: string };
  estado: "prueba" | "activa";
  pruebaVenceEn: Date | null;
  rucsUsados: number;
  usuarios: { activos: number; pendientes: number };
};
const leerLimites = (tx: Tx, t: string) =>
  exportado<(tx: Tx, t: string) => Promise<Limites | null>>("leerLimites")(tx, t);
const usoDelEstudio = (tx: Tx, t: string) =>
  exportado<(tx: Tx, t: string) => Promise<Uso | null>>("usoDelEstudio")(tx, t);
const contarUsuarios = (tx: Tx, t: string) =>
  exportado<(tx: Tx, t: string) => Promise<unknown>>("contarUsuarios")(tx, t);

let admin: Pool;
let ep: EscenarioPlanes;
let db: ContappDb;

beforeAll(() => {
  admin = abrirAdmin(4);
  ep = new EscenarioPlanes(admin);
  db = crearDb("contapp_backend", 2);
});
afterAll(async () => {
  await ep?.limpiar();
  await db?.close().catch(() => undefined);
  await admin?.end();
});

describe("leerLimites", () => {
  it("devuelve los limites del plan y los RUCs extra contratados, como numeros", async () => {
    const p = await ep.plan({ maxRucs: 30, maxUsuarios: 2, maxRucsExtra: 6 });
    const x = await ep.estudioConPlan(p.id, { rucsExtra: 3 });
    const r = await db.withTenant({ tenantId: x.id }, (tx) => leerLimites(tx, x.id));
    expect(r).toEqual({ maxRucs: 30, maxUsuarios: 2, maxRucsExtra: 6, rucsExtraContratados: 3 });
  });

  it("maxUsuarios null (plan sin limite de usuarios) se conserva como null", async () => {
    const p = await ep.plan({ maxUsuarios: null });
    const x = await ep.estudioConPlan(p.id);
    const r = await db.withTenant({ tenantId: x.id }, (tx) => leerLimites(tx, x.id));
    expect(r?.maxUsuarios).toBeNull();
    expect(r?.rucsExtraContratados).toBe(0);
  });

  it("estudio sin suscripcion -> null", async () => {
    const x = await ep.ea.estudio();
    expect(await db.withTenant({ tenantId: x.id }, (tx) => leerLimites(tx, x.id))).toBeNull();
  });
});

describe("usoDelEstudio", () => {
  it("arma plan, estado, vencimiento de la prueba, limites, RUCs usados y usuarios (activos y pendientes)", async () => {
    const p = await ep.plan({ maxRucs: 12, maxUsuarios: 4, maxRucsExtra: 2 });
    const { x } = await ep.estudioConUsuarios(p.id, { activos: 2, desactivados: 1, pendientes: 1, vencidas: 1 });
    await ep.ea.clientes(x.id, 3);
    const r = await db.withTenant({ tenantId: x.id }, (tx) => usoDelEstudio(tx, x.id));
    expect(r).toMatchObject({
      plan: { codigo: p.codigo, nombre: `Plan T1 ${p.codigo}` },
      estado: "activa",
      pruebaVenceEn: null,
      maxRucs: 12,
      maxUsuarios: 4,
      maxRucsExtra: 2,
      rucsExtraContratados: 0,
      rucsUsados: 3,
      usuarios: { activos: 2, pendientes: 1 },
    });
    expect(typeof r?.rucsUsados).toBe("number");
  });

  it("en prueba devuelve la fecha de vencimiento; con plan sin limite de usuarios, maxUsuarios null", async () => {
    const p = await ep.plan({ maxUsuarios: null });
    const x = await ep.estudioConPlan(p.id, { estado: "prueba", rucsExtra: 1 });
    const r = await db.withTenant({ tenantId: x.id }, (tx) => usoDelEstudio(tx, x.id));
    expect(r?.estado).toBe("prueba");
    expect(r?.pruebaVenceEn).toBeInstanceOf(Date);
    expect(r?.maxUsuarios).toBeNull();
    expect(r?.rucsExtraContratados).toBe(1);
    expect(r?.usuarios).toEqual({ activos: 0, pendientes: 0 });
  });

  it("estudio sin suscripcion -> null", async () => {
    const x = await ep.ea.estudio();
    expect(await db.withTenant({ tenantId: x.id }, (tx) => usoDelEstudio(tx, x.id))).toBeNull();
  });
});

describe("errores de los repos de planes: solo el SQLSTATE", () => {
  it("un uuid invalido sale como PlanesRepoError con codigo 22P02 y sin el texto original", async () => {
    const error = await db
      .withTenant({ tenantId: (await ep.ea.estudio()).id }, (tx) => contarUsuarios(tx, "no-es-uuid"))
      .catch((e: unknown) => e);
    expect((error as Error).name).toBe("PlanesRepoError");
    expect((error as { codigo: string }).codigo).toBe("22P02");
    expect(String((error as Error).message)).not.toContain("no-es-uuid");
  });
});
