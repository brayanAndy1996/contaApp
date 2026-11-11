// Spec 017 · T16 · Pruebas (en rojo) de las correcciones de la ronda adversarial R1 sobre notificaciones y plan:
//  · Observación de P-5 (decisión del usuario, 2026-11-11): «una vez por día».
//  · H-017-2 (parte plan): el DELETE de membresia y de cliente recalcula `plan_aviso`.
//  · H-017-3: `notificaciones_de_esta_transaccion()` solo devuelve destinatarios de filas insertadas por la transacción en curso.
//
// CONTRATO QUE FIJAN ESTAS PRUEBAS (lo implementa T17 en la migración 0045, sin editar 0043):
//  1. Ventana de 24 h: antes de insertar un aviso `plan_limite`, `plan_aviso_recalcular` omite al Dueño que ya tiene un `plan_limite` del MISMO
//     recurso y umbral con `notificacion.creada_en` de hace menos de 24 h (la ventana se mide sobre la tabla `notificacion`, no sobre un
//     estado nuevo). Es por Dueño, por recurso y por umbral: otro Dueño, otro umbral u otro recurso avisan con normalidad. El estado de
//     `plan_aviso` (alcanzado, ciclo) sigue su curso aunque el aviso se omita; pasadas 24 h un nuevo cruce avisa (clave con el ciclo nuevo).
//  2. DELETE de `membresia` y de `cliente` dispara `plan_aviso_recalcular` del estudio (bajar del umbral lo rearma), como los UPDATE de 0043.
//  3. `notificaciones_de_esta_transaccion()` ignora todo id de `app.notificaciones_tx` cuya fila no la insertó la transacción en curso
//     (de otra transacción, de otro estudio o ajeno): no devuelve su destinatario.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "./soporte";
import { abrirAdmin, crearDb, EscenarioNotif, exportado } from "./notificaciones-soporte";

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

/** Estudio con plan propio: 2 Duenos activos, 1 Dueno desactivado, 1 Administrador y 1 Contador (como notificaciones-plan.spec.ts). */
async function estudio(o: { maxRucs?: number; maxUsuarios?: number | null } = {}) {
  const plan = await en.ep.plan({ maxRucs: o.maxRucs ?? 10, maxUsuarios: o.maxUsuarios === undefined ? 1000 : o.maxUsuarios, maxRucsExtra: 2 });
  const x = await en.ep.estudioConPlan(plan.id, { rucsExtra: 0 });
  const d1 = (await en.ep.ea.miembro(x.id, "dueno")).id;
  const d2 = (await en.ep.ea.miembro(x.id, "dueno")).id;
  await en.ep.ea.miembro(x.id, "dueno", { desactivada: true });
  await en.ep.ea.miembro(x.id, "admin");
  await en.ep.ea.miembro(x.id, "contador");
  return { x: x.id, d1, d2, duenos: [d1, d2].sort() };
}
const quienes = (ns: { usuario_id: string }[]): string[] => ns.map((n) => n.usuario_id).sort();
const total = async (x: string): Promise<number> => (await en.notifs(x, { tipo: "plan_limite" })).length;
/** Estado `alcanzado` de cada umbral de un recurso (lectura con el superusuario: la app no tiene grants sobre plan_aviso). */
async function alcanzados(x: string, recurso: "rucs" | "usuarios"): Promise<Record<number, boolean>> {
  const r = await admin.query("select umbral, alcanzado from plan_aviso where tenant_id = $1 and recurso = $2 order by umbral", [x, recurso]);
  return Object.fromEntries(r.rows.map((fila) => [fila.umbral as number, fila.alcanzado as boolean]));
}
const comoBackend = <T>(x: string, u: string, fn: (tx: any) => Promise<T>) => backend.withTenant({ tenantId: x, userId: u }, fn);
const rucNuevo = () => `38${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

// =================================================================================================
describe("P-5 · el mismo aviso de límite no se repite al mismo Dueño dentro de 24 h («una vez por día»)", () => {
  it("archivar y reactivar un cliente alrededor del 90 % varias veces deja UN aviso por Dueño, no uno por oscilación", async () => {
    const e = await estudio({ maxRucs: 10 });
    const ids = await en.clientes(e.x, 9); // 9 de 10 = 90 %
    expect(quienes(await en.avisosPlan(e.x, "rucs", 90))).toEqual(e.duenos);
    for (let i = 0; i < 3; i++) {
      await admin.query("update cliente set archivado_at = now() where id = $1", [ids[0]]); // 8 de 10: se rearma
      await admin.query("update cliente set archivado_at = null where id = $1", [ids[0]]); // 9 de 10: vuelve a cruzar
    }
    expect(quienes(await en.avisosPlan(e.x, "rucs", 90)), "tres cruces en el mismo día: sigue habiendo un solo aviso por Dueño").toEqual(e.duenos);
    expect(await total(e.x)).toBe(2);
  });

  it("lo mismo con usuarios: revocar y volver a invitar alrededor del 100 % no repite el aviso del 100 % ni el del 90 %", async () => {
    const e = await estudio({ maxUsuarios: 10, maxRucs: 1000 }); // 4 activos (2 Duenos, Admin, Contador)
    for (let i = 0; i < 4; i++) await en.ep.ea.miembro(e.x, "contador"); // 8
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1 }); // 9 = 90 %
    const inv = await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1 }); // 10 = 100 %
    expect(quienes(await en.avisosPlan(e.x, "usuarios", 100))).toEqual(e.duenos);
    await admin.query("update invitacion set revocada_en = now() where id = $1", [inv.id]); // 9: el 100 % se rearma
    await en.ep.ea.invitacion(e.x, { invitadoPor: e.d1 }); // 10 otra vez, el mismo día
    expect(quienes(await en.avisosPlan(e.x, "usuarios", 100)), "el 100 % no se repite dentro de 24 h").toEqual(e.duenos);
    expect(quienes(await en.avisosPlan(e.x, "usuarios", 90))).toEqual(e.duenos);
    expect(await total(e.x)).toBe(4);
  });

  it("la ventana es de 24 h: a las 23 h el aviso sigue omitido; a las 25 h un nuevo cruce sí avisa, con una clave distinta", async () => {
    const e = await estudio({ maxRucs: 10 });
    const ids = await en.clientes(e.x, 9);
    await en.envejecer(e.x, 23);
    await admin.query("update cliente set archivado_at = now() where id = $1", [ids[0]]);
    await admin.query("update cliente set archivado_at = null where id = $1", [ids[0]]);
    expect(await en.avisosPlan(e.x, "rucs", 90), "a las 23 h todavía no").toHaveLength(2);
    await en.envejecer(e.x, 2); // ahora el aviso tiene 25 h
    await admin.query("update cliente set archivado_at = now() where id = $1", [ids[0]]);
    await admin.query("update cliente set archivado_at = null where id = $1", [ids[0]]);
    const ns = await en.avisosPlan(e.x, "rucs", 90);
    expect(quienes(ns), "a las 25 h sí: un aviso más por Dueño").toEqual([...e.duenos, ...e.duenos].sort());
    const claves = ns.map((n) => `${n.usuario_id}:${n.clave_dedupe}`);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it("la omisión es por Dueño: un Dueño que no recibió el aviso de las últimas 24 h sí lo recibe en el nuevo cruce", async () => {
    const e = await estudio({ maxRucs: 10 });
    const ids = await en.clientes(e.x, 9);
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
    const d3 = (await en.ep.ea.miembro(e.x, "dueno")).id; // llega después del primer aviso
    await admin.query("update cliente set archivado_at = now() where id = $1", [ids[0]]);
    await admin.query("update cliente set archivado_at = null where id = $1", [ids[0]]);
    const ns = await en.avisosPlan(e.x, "rucs", 90);
    expect(quienes(ns)).toEqual([...e.duenos, d3].sort());
  });

  it("la omisión es por umbral: oscilar el 90 % no impide el aviso del 100 % que llega después, el mismo día", async () => {
    const e = await estudio({ maxRucs: 10 });
    const ids = await en.clientes(e.x, 9);
    await admin.query("update cliente set archivado_at = now() where id = $1", [ids[0]]);
    await admin.query("update cliente set archivado_at = null where id = $1", [ids[0]]);
    expect(await en.avisosPlan(e.x, "rucs", 90)).toHaveLength(2);
    await en.clientes(e.x, 1); // 10 de 10
    expect(quienes(await en.avisosPlan(e.x, "rucs", 100))).toEqual(e.duenos);
    expect(await total(e.x)).toBe(4);
  });
});

// =================================================================================================
describe("H-017-2 · el DELETE de membresia y de cliente recalcula plan_aviso (los grants lo permiten)", () => {
  it("borrar un cliente que estaba en el 100 % rearma el umbral: pasado el día, volver a llegar avisa", async () => {
    const e = await estudio({ maxRucs: 10 });
    const ids = await en.clientes(e.x, 10); // 100 %
    expect(await alcanzados(e.x, "rucs")).toEqual({ 90: true, 100: true });
    await comoBackend(e.x, e.d1, (tx) => tx.query("delete from cliente where id = $1", [ids[0]])); // 9 de 10
    expect(await alcanzados(e.x, "rucs"), "el DELETE no recalculó plan_aviso: el 100 % sigue marcado como alcanzado").toEqual({ 90: true, 100: false });
    await en.envejecer(e.x, 25); // fuera de la ventana de 24 h
    await en.clientes(e.x, 1); // 10 de 10 otra vez
    expect(quienes(await en.avisosPlan(e.x, "rucs", 100))).toEqual([...e.duenos, ...e.duenos].sort());
  });

  it("borrar un cliente que estaba en el 90 % rearma el 90 % (y deja el 100 % sin alcanzar)", async () => {
    const e = await estudio({ maxRucs: 10 });
    const ids = await en.clientes(e.x, 9);
    await comoBackend(e.x, e.d1, (tx) => tx.query("delete from cliente where id = $1", [ids[0]])); // 8 de 10
    expect(await alcanzados(e.x, "rucs")).toEqual({ 90: false, 100: false });
  });

  it("borrar una membresía que estaba en el 100 % de usuarios rearma el umbral: pasado el día, volver a llegar avisa", async () => {
    const e = await estudio({ maxUsuarios: 10, maxRucs: 1000 }); // 4 activos
    const miembros: string[] = [];
    for (let i = 0; i < 6; i++) miembros.push((await en.ep.ea.miembro(e.x, "contador")).id); // 10
    expect(await alcanzados(e.x, "usuarios")).toEqual({ 90: true, 100: true });
    await comoBackend(e.x, e.d1, (tx) => tx.query("delete from membresia where tenant_id = $1 and usuario_id = $2", [e.x, miembros[0]])); // 9
    expect(await alcanzados(e.x, "usuarios"), "el DELETE no recalculó plan_aviso: el 100 % sigue marcado como alcanzado").toEqual({ 90: true, 100: false });
    await en.envejecer(e.x, 25);
    await en.ep.ea.miembro(e.x, "contador"); // 10 otra vez
    expect(quienes(await en.avisosPlan(e.x, "usuarios", 100))).toEqual([...e.duenos, ...e.duenos].sort());
  });
});

// =================================================================================================
describe("H-017-3 · destinatariosNuevos solo devuelve a quien notificó esta transacción", () => {
  /** Un cliente que cruza el 90 % dentro de la transacción (aviso legítimo a los Dueños) y, antes de leer, `inyectar` ids en el GUC. */
  async function conCruce(e: Awaited<ReturnType<typeof estudio>>, inyectar: string[]): Promise<string[]> {
    return comoBackend(e.x, e.d1, async (tx) => {
      await f("crearCliente")(tx, e.x, { ruc: rucNuevo(), razonSocial: "Cliente cruce H-017-3" });
      for (const id of inyectar) {
        await tx.query("select set_config('app.notificaciones_tx', coalesce(nullif(current_setting('app.notificaciones_tx', true), ''), '') || ',' || $1, true)", [id]);
      }
      return (await f("destinatariosNuevos")(tx)) as string[];
    });
  }

  it("control: sin inyectar nada, devuelve exactamente a los Dueños avisados en la transacción", async () => {
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 8);
    expect([...(await conCruce(e, []))].sort()).toEqual(e.duenos);
  });

  it("un id de otra notificación del estudio agregado a app.notificaciones_tx no suma su destinatario a los de la transacción", async () => {
    const e = await estudio({ maxRucs: 10 });
    await en.clientes(e.x, 8);
    const ajeno = (await en.ep.ea.miembro(e.x, "contador")).id;
    const vieja = await en.notificar(e.x, ajeno, { hace: 3600 });
    expect([...(await conCruce(e, [vieja]))].sort(), "el destinatario de una notificación que esta transacción no creó salió en la lista").toEqual(e.duenos);
  });

  it("un id de otro estudio o una notificación propia de una transacción anterior ya confirmada tampoco cuentan; sin avisos nuevos, la lista es vacía", async () => {
    const e = await estudio({ maxRucs: 10 });
    const otro = await estudio({ maxRucs: 10 });
    const deOtro = await en.notificar(otro.x, otro.d1, { hace: 3600 });
    const propia = await en.notificar(e.x, e.d1, { hace: 3600 });
    const devueltos = await comoBackend(e.x, e.d1, async (tx) => {
      await tx.query("select set_config('app.notificaciones_tx', $1, true)", [`${deOtro},${propia},${randomUUID()}`]);
      return (await f("destinatariosNuevos")(tx)) as string[];
    });
    expect(devueltos).toEqual([]);
  });
});
