// Spec 017 (T3, rojo): avisos de limite del plan (CA-10, P-5) contra la BD real. Al cruzar el 90 % y el 100 % de RUCs o de
// usuarios se avisa una vez a cada Dueno activo; repetir sin bajar no avisa; bajar del umbral y volver a cruzar avisa otra
// vez. El estado vive en `plan_aviso` (serializado por fila) y los triggers son `FOR EACH STATEMENT` sobre cliente, membresia,
// invitacion y suscripcion. Contrato en notificaciones-soporte.ts. Falla hoy por tabla `notificacion` ausente (0043 de T7).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "./soporte";
import { dormir, abrirAdmin, crearDb, EscenarioNotif, exportado } from "./notificaciones-soporte";

type Fn = (...a: any[]) => Promise<any>;
const f = (nombre: string) => exportado<Fn>(nombre);

let admin: Pool;
let en: EscenarioNotif;
let backend: ContappDb;

beforeAll(() => {
  admin = abrirAdmin(8);
  en = new EscenarioNotif(admin);
  backend = crearDb("contapp_backend", 4);
});
afterAll(async () => {
  await en?.limpiar();
  await backend?.close().catch(() => undefined);
  await admin?.end();
});

/** Estudio con plan propio: 2 Duenos activos, 1 Dueno desactivado, 1 Administrador y 1 Contador. */
async function estudio(o: { maxRucs?: number; maxUsuarios?: number | null; maxRucsExtra?: number; rucsExtra?: number } = {}) {
  const plan = await en.ep.plan({
    maxRucs: o.maxRucs ?? 10,
    maxUsuarios: o.maxUsuarios === undefined ? 1000 : o.maxUsuarios,
    maxRucsExtra: o.maxRucsExtra ?? 2,
  });
  const x = await en.ep.estudioConPlan(plan.id, { rucsExtra: o.rucsExtra ?? 0 });
  const d1 = (await en.ep.ea.miembro(x.id, "dueno")).id;
  const d2 = (await en.ep.ea.miembro(x.id, "dueno")).id;
  const baja = (await en.ep.ea.miembro(x.id, "dueno", { desactivada: true })).id;
  const adm = (await en.ep.ea.miembro(x.id, "admin")).id;
  await en.ep.ea.miembro(x.id, "contador");
  return { plan, x: x.id, d1, d2, baja, adm, duenos: [d1, d2].sort() };
}
const quienes = (ns: { usuario_id: string }[]): string[] => ns.map((n) => n.usuario_id).sort();
const total = async (x: string): Promise<number> => (await en.notifs(x, { tipo: "plan_limite" })).length;

// =================================================================================================
describe("CA-10 · RUCs: 90 % y 100 % del limite efectivo (P-5)", () => {
  it("al cruzar el 90 % avisa a cada Dueno activo, con recurso, umbral, usado y limite; solo a ellos", async () => {
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 8);
    expect(await total(e.x)).toBe(0);
    await en.clientes(e.x, 1); // 9 de 10 = 90 %
    const ns = await en.avisosPlan(e.x, "rucs", 90);
    expect(quienes(ns)).toEqual(e.duenos);
    for (const n of ns) {
      expect(n.tipo).toBe("plan_limite");
      expect(n.cliente_id).toBeNull();
      expect(n.trabajo_id).toBeNull();
      expect(n.leida_en).toBeNull();
      expect(n.params).toEqual({ recurso: "rucs", umbral: 90, usado: 9, limite: 10 });
      expect(n.clave_dedupe.startsWith("plan_limite:rucs:90:")).toBe(true);
    }
    expect(await total(e.x)).toBe(2); // nadie mas: ni el desactivado, ni el Administrador, ni el Contador
    expect(await en.avisosPlan(e.x, "rucs", 100)).toHaveLength(0);
  });

  it("al llegar al 100 % avisa de nuevo, con el umbral 100, y no repite el del 90 %", async () => {
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 9);
    await en.clientes(e.x, 1); // 10 de 10
    expect(quienes(await en.avisosPlan(e.x, "rucs", 100))).toEqual(e.duenos);
    expect((await en.avisosPlan(e.x, "rucs", 100))[0].params).toEqual({ recurso: "rucs", umbral: 100, usado: 10, limite: 10 });
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
    expect(await total(e.x)).toBe(4);
  });

  it("repetir sin bajar no avisa: mas RUCs sobre el limite y una suscripcion sin cambios", async () => {
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 10);
    expect(await total(e.x)).toBe(4);
    await en.clientes(e.x, 2); // 12 de 10: ya alcanzados los dos umbrales
    await admin.query("update suscripcion set rucs_extra_contratados = rucs_extra_contratados where tenant_id = $1", [e.x]);
    expect(await total(e.x)).toBe(4);
  });

  it("cruzar los dos umbrales en una sola sentencia deja un aviso de cada umbral por Dueno", async () => {
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 10);
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
    expect(await en.avisosPlan(e.x, "rucs", 100)).toHaveLength(2);
  });

  it("bajar del umbral y volver a cruzarlo avisa otra vez (clave nueva), solo el umbral que se rearmo", async () => {
    const e = await estudio({ maxRucs: 10 });
    const ids = await en.clientes(e.x, 10);
    expect(await total(e.x)).toBe(4);
    // 10 -> 9: el 100 % se rearma, el 90 % sigue alcanzado
    await admin.query("update cliente set archivado_at = now() where id = $1", [ids[0]]);
    expect(await total(e.x)).toBe(4);
    await en.envejecer(e.x, 25); // el mismo aviso no se repite antes de 24 h (notificaciones-correcciones.spec.ts); aqui ya paso ese dia
    await admin.query("update cliente set archivado_at = null where id = $1", [ids[0]]);
    expect(await en.avisosPlan(e.x, "rucs", 100)).toHaveLength(4);
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
    // 10 -> 8 -> 9: el 90 % se rearmo y vuelve a avisar
    await admin.query("update cliente set archivado_at = now() where id = any($1::uuid[])", [[ids[0], ids[1]]]);
    await en.envejecer(e.x, 25);
    await admin.query("update cliente set archivado_at = null where id = any($1::uuid[])", [[ids[0], ids[1]]]);
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(4);
    const claves = (await en.notifs(e.x, { tipo: "plan_limite" })).map((n) => `${n.usuario_id}:${n.clave_dedupe}`);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it("los clientes archivados no cuentan para el uso", async () => {
    const e = await estudio({ maxRucs: 10 });
    const ids = await en.clientes(e.x, 8);
    await admin.query("update cliente set archivado_at = now() where id = $1", [ids[0]]); // 7 activos
    await en.clientes(e.x, 1); // 8 activos de 10 (9 filas): nada
    expect(await total(e.x)).toBe(0);
    await en.clientes(e.x, 1); // 9 activos: 90 %
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
    expect((await en.avisosPlan(e.x, "rucs", 90))[0].params).toMatchObject({ usado: 9, limite: 10 });
  });

  it("el limite efectivo suma los RUC extra contratados, con tope en el maximo del plan", async () => {
    const e = await estudio({ maxRucs: 10, maxRucsExtra: 2, rucsExtra: 2 }); // limite 12
    await en.clientes(e.x, 10); // 10 de 12 = 83 %
    expect(await total(e.x)).toBe(0);
    await en.clientes(e.x, 1); // 11 de 12 = 91 %
    const ns = await en.avisosPlan(e.x, "rucs", 90);
    expect(quienes(ns)).toEqual(e.duenos);
    expect(ns[0].params).toEqual({ recurso: "rucs", umbral: 90, usado: 11, limite: 12 });

    const tope = await estudio({ maxRucs: 10, maxRucsExtra: 2, rucsExtra: 5 }); // 5 > tope 2: limite 12
    await en.clientes(tope.x, 11);
    expect((await en.avisosPlan(tope.x, "rucs", 90))[0].params).toMatchObject({ usado: 11, limite: 12 });
  });

  it("un cambio de la suscripcion que baja el limite avisa en ese cambio de uso", async () => {
    const e = await estudio({ maxRucs: 10, maxRucsExtra: 2, rucsExtra: 2 }); // limite 12
    await en.clientes(e.x, 10);
    expect(await total(e.x)).toBe(0);
    await admin.query("update suscripcion set rucs_extra_contratados = 0 where tenant_id = $1", [e.x]); // limite 10: 100 %
    expect((await en.avisosPlan(e.x, "rucs", 100))[0].params).toEqual({ recurso: "rucs", umbral: 100, usado: 10, limite: 10 });
    expect(quienes(await en.avisosPlan(e.x, "rucs", 100))).toEqual(e.duenos);
  });

  it("si el super-admin cambia los limites del plan no se avisa al momento: sale en el siguiente cambio de uso", async () => {
    const e = await estudio({ maxRucs: 10, maxRucsExtra: 0 }); // sin extras: el tope de extras (20 %) no impide bajar max_rucs
    await en.clientes(e.x, 6);
    await admin.query("update plan set max_rucs = 7 where id = $1", [e.plan.id]); // 6 de 7 = 86 %
    await admin.query("update plan set max_rucs = 6 where id = $1", [e.plan.id]); // 6 de 6 = 100 %
    expect(await total(e.x)).toBe(0);
    await en.clientes(e.x, 1); // siguiente cambio de uso: 7 de 6
    expect((await en.avisosPlan(e.x, "rucs", 100)).length).toBeGreaterThan(0);
    expect(quienes(await en.avisosPlan(e.x, "rucs", 100))).toEqual(e.duenos);
  });

  it("si la transaccion se revierte no hay aviso ni se adelanta el estado: el cruce real despues si avisa", async () => {
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 8);
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await en.clientes(e.x, 1, c);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(await total(e.x)).toBe(0);
    await en.clientes(e.x, 1);
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
  });

  it("dos transacciones concurrentes que cruzan juntas: un aviso por umbral y Dueno (se serializan por fila)", async () => {
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 7);
    const a = await admin.connect();
    const b = await admin.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await en.clientes(e.x, 2, a); // A solo ve 9 de 10
      const pendiente = en.clientes(e.x, 2, b); // B espera el bloqueo de A
      await dormir(300);
      await a.query("COMMIT");
      await pendiente; // B ve 11 de 10
      await b.query("COMMIT");
    } finally {
      a.release();
      b.release();
    }
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
    expect(await en.avisosPlan(e.x, "rucs", 100)).toHaveLength(2);
    expect(quienes(await en.avisosPlan(e.x, "rucs", 100))).toEqual(e.duenos);
  });

  it("un cliente dado de alta por el backend avisa y destinatariosNuevos devuelve a los Duenos (aviso en vivo)", async () => {
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 8);
    const nuevos = await backend.withTenant({ tenantId: e.x, userId: e.d1 }, async (tx) => {
      await f("crearCliente")(tx, e.x, { ruc: `38${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, razonSocial: "Cliente alta backend" });
      return (await f("destinatariosNuevos")(tx)) as string[];
    });
    expect([...nuevos].sort()).toEqual(e.duenos);
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
  });
});

// =================================================================================================
describe("CA-10 · usuarios: membresias activas + invitaciones vigentes (P-5)", () => {
  it("avisa al cruzar el 90 % y el 100 % del limite de usuarios, con las invitaciones vigentes incluidas", async () => {
    const e = await estudio({ maxUsuarios: 10, maxRucs: 1000 }); // 3 activos (2 Duenos, 1 Admin) + 1 Contador = 4; baja no cuenta
    for (let i = 0; i < 3; i++) await en.ep.ea.miembro(e.x, "contador"); // 7
    expect(await total(e.x)).toBe(0);
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1 }); // 8
    expect(await total(e.x)).toBe(0);
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1 }); // 9 = 90 %
    const ns = await en.avisosPlan(e.x, "usuarios", 90);
    expect(quienes(ns)).toEqual(e.duenos);
    expect(ns[0].params).toEqual({ recurso: "usuarios", umbral: 90, usado: 9, limite: 10 });
    expect(await en.avisosPlan(e.x, "usuarios", 100)).toHaveLength(0);
    await en.ep.ea.miembro(e.x, "lectura"); // 10 = 100 %
    const cien = await en.avisosPlan(e.x, "usuarios", 100);
    expect(quienes(cien)).toEqual(e.duenos);
    expect(cien[0].params).toEqual({ recurso: "usuarios", umbral: 100, usado: 10, limite: 10 });
    expect(await total(e.x)).toBe(4);
  });

  it("no cuentan las desactivadas, las invitaciones vencidas, aceptadas ni revocadas", async () => {
    const e = await estudio({ maxUsuarios: 10, maxRucs: 1000 }); // 4 activos
    for (let i = 0; i < 4; i++) await en.ep.ea.miembro(e.x, "contador", { desactivada: true });
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1, vencida: true });
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1, aceptada: true });
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1, revocada: true });
    await en.ep.ea.miembro(e.x, "contador"); // 5 activos
    expect(await total(e.x)).toBe(0);
  });

  it("revocar una invitacion o desactivar a un miembro baja del 100 %; volver a llegar avisa de nuevo", async () => {
    const e = await estudio({ maxUsuarios: 10, maxRucs: 1000 }); // 4
    const miembros: string[] = [];
    for (let i = 0; i < 4; i++) miembros.push((await en.ep.ea.miembro(e.x, "contador")).id); // 8
    const inv = await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1 }); // 9
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1 }); // 10
    expect(await en.avisosPlan(e.x, "usuarios", 100)).toHaveLength(2);
    await admin.query("update invitacion set revocada_en = now() where id = $1", [inv.id]); // 9
    expect(await en.avisosPlan(e.x, "usuarios", 100)).toHaveLength(2);
    await en.envejecer(e.x, 25); // pasado el dia de la ventana de P-5 (ver notificaciones-correcciones.spec.ts)
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1 }); // 10 otra vez
    expect(await en.avisosPlan(e.x, "usuarios", 100)).toHaveLength(4);
    expect(await en.avisosPlan(e.x, "usuarios", 90)).toHaveLength(2);
    await admin.query("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [e.x, miembros[0]]); // 9
    expect(await en.avisosPlan(e.x, "usuarios", 100)).toHaveLength(4);
    await en.envejecer(e.x, 25);
    await admin.query("update membresia set desactivada_en = null where tenant_id = $1 and usuario_id = $2", [e.x, miembros[0]]); // 10
    expect(await en.avisosPlan(e.x, "usuarios", 100)).toHaveLength(6);
    expect(quienes(await en.avisosPlan(e.x, "usuarios", 100))).toEqual([...e.duenos, ...e.duenos, ...e.duenos].sort());
  });

  it("max_usuarios NULL (sin limite) no avisa nunca por usuarios", async () => {
    const e = await estudio({ maxUsuarios: null, maxRucs: 1000 });
    for (let i = 0; i < 25; i++) await en.ep.ea.miembro(e.x, "contador");
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1 });
    expect(await en.avisosPlan(e.x, "usuarios", 90)).toHaveLength(0);
    expect(await en.avisosPlan(e.x, "usuarios", 100)).toHaveLength(0);
  });

  it("los usuarios y los RUCs se avisan por separado, cada uno con su recurso", async () => {
    const e = await estudio({ maxUsuarios: 10, maxRucs: 10 });
    await en.clientes(e.x, 9);
    for (let i = 0; i < 5; i++) await en.ep.ea.miembro(e.x, "contador"); // 4 + 5 = 9
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
    expect(await en.avisosPlan(e.x, "usuarios", 90)).toHaveLength(2);
    expect(await total(e.x)).toBe(4);
  });
});

// =================================================================================================
describe("estudios sin suscripcion y siembra de 0043", () => {
  it("un estudio sin suscripcion no rompe las altas ni genera avisos", async () => {
    const x = (await en.ep.ea.estudio()).id;
    await en.ep.ea.miembro(x, "dueno");
    await en.clientes(x, 5);
    await en.ep.ea.invitacion(x, { invitadoPor: (await en.ep.ea.miembro(x, "dueno")).id });
    expect(await total(x)).toBe(0);
  });

  it("la siembra no notifica: ningun aviso de plan lleva el ciclo 0 del estado sembrado", async () => {
    const r = await admin.query(
      "select count(*)::int as n from notificacion where tipo = 'plan_limite' and clave_dedupe like 'plan_limite:%:0'",
    );
    expect(r.rows[0].n).toBe(0);
    // y los avisos que si salen traen un ciclo >= 1 en la clave
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 9);
    for (const n of await en.avisosPlan(e.x, "rucs", 90)) {
      expect(Number(n.clave_dedupe.split(":").pop())).toBeGreaterThanOrEqual(1);
    }
  });
});
