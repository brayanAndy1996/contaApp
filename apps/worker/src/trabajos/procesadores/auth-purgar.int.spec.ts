import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  auditoriaDe,
  limpiarFilas017,
  notificacionesDe,
} from "../../../test/notificaciones.js";
import { crearDbAdmin, crearDbRol, Escenario } from "../../../test/trabajos.js";
import { authPurgar } from "./auth-purgar.js";

// Spec 017 · T4 (rojo; integración con PostgreSQL real, rol contapp_worker): `auth.purgar` borra las notificaciones de más de
// 90 días de CADA estudio, leídas o no, y lo cuenta en `resultado.notificaciones`; la auditoría no se purga (P-7, D-7, CA-15).
// Contrato: ver auth-purgar.spec.ts. El worker no tiene grants sobre `notificacion`: la purga pasa por `notificacion_purgar`
// (SECURITY DEFINER, solo del estudio de la transacción).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let admin: ContappDb;
let worker: ContappDb;
let e: Escenario;

beforeAll(async () => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 4);
  e = new Escenario(admin);
});

afterAll(async () => {
  await limpiarFilas017(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  await Promise.all([worker?.close(), admin?.close()]);
});

async function notificar(
  tenantId: string,
  usuarioId: string,
  diasAtras: number,
  leida: boolean,
): Promise<string> {
  const id = randomUUID();
  await admin.pool.query(
    `insert into notificacion (id, tenant_id, usuario_id, tipo, params, clave_dedupe, creada_en, leida_en)
     values ($1, $2, $3, 'trabajo_terminado', '{"tipoTrabajo":"prueba.eco","estado":"completado","motivo":null}'::jsonb, $4,
             now() - make_interval(days => $5::int, mins => 5), case when $6::boolean then now() else null end)`,
    [id, tenantId, usuarioId, `purga:${id}`, diasAtras, leida],
  );
  return id;
}

const vivas = async (tenantId: string): Promise<Set<string>> =>
  new Set((await notificacionesDe(admin, tenantId)).map((n) => n.id));

describe("CA-15: auth.purgar y las notificaciones", () => {
  it("borra las de más de 90 días de cada estudio (leídas o no), deja las de 90 días o menos y las cuenta", async () => {
    const T1 = await e.estudio();
    const T2 = await e.estudio();
    const u1 = await e.usuario(T1, "contador");
    const u2 = await e.usuario(T2, "contador");
    const viejaSinLeer1 = await notificar(T1, u1, 100, false);
    const viejaLeida1 = await notificar(T1, u1, 91, true);
    const dentro1 = await notificar(T1, u1, 89, false);
    const reciente1 = await notificar(T1, u1, 1, true);
    const viejaSinLeer2 = await notificar(T2, u2, 400, false);
    const dentro2 = await notificar(T2, u2, 30, false);
    expect(await vivas(T1)).toEqual(
      new Set([viejaSinLeer1, viejaLeida1, dentro1, reciente1]),
    );

    const r = await authPurgar({ db: worker });

    expect(
      r.notificaciones,
      "al menos las tres de esta prueba (la base puede traer más)",
    ).toBeGreaterThanOrEqual(3);
    expect(await vivas(T1)).toEqual(new Set([dentro1, reciente1]));
    expect(await vivas(T2)).toEqual(new Set([dentro2]));
    expect(await vivas(T2)).not.toContain(viejaSinLeer2);
  });

  it("es idempotente: la segunda corrida no encuentra nada de esta prueba", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "contador");
    const vieja = await notificar(T, u, 120, false);
    const nueva = await notificar(T, u, 2, false);
    await authPurgar({ db: worker });
    expect(await vivas(T)).toEqual(new Set([nueva]));
    await authPurgar({ db: worker });
    expect(await vivas(T)).toEqual(new Set([nueva]));
    expect(await vivas(T)).not.toContain(vieja);
  });

  it("la auditoría no se purga: una fila de hace 2.000 días sigue ahí (D-7)", async () => {
    const T = await e.estudio();
    await e.usuario(T, "dueno");
    await e.cliente(T); // el trigger deja `cliente.creado`
    const antes = await auditoriaDe(admin, T);
    expect(
      antes.length,
      "los triggers de 0041/0042 dejan filas",
    ).toBeGreaterThan(0);
    const c = await admin.pool.connect();
    try {
      await c.query("SET session_replication_role = replica"); // el trigger de inmutabilidad solo lo salta este modo
      await c.query(
        "update auditoria set ocurrida_en = now() - interval '2000 days' where tenant_id = $1",
        [T],
      );
    } finally {
      c.release(true);
    }
    await authPurgar({ db: worker });
    expect((await auditoriaDe(admin, T)).map((f) => f.id).sort()).toEqual(
      antes.map((f) => f.id).sort(),
    );
  });

  it("el rol del worker no puede tocar la tabla directamente: la purga solo existe por la función", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "contador");
    await notificar(T, u, 5, false);
    await expect(
      worker.withTenant({ tenantId: T }, (tx) =>
        tx.query("delete from notificacion where tenant_id = $1", [T]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await notificacionesDe(admin, T)).length).toBe(1);
  });
});
