// Spec 020 (T3, DT-8, CA-10): la migracion 0046 trunca a ms las notificaciones con microsegundos y valida
// `notificacion_creada_en_ms`, sin dejar el trigger `notificacion_solo_leida` deshabilitado y sin tocar `auditoria`.
// Todo corre en UNA transaccion con el superusuario que se revierte al final: no deja filas ni cambia constraints en la BD
// compartida, y el estado previo a 0046 (CHECK NOT VALID + una fila con us) existe solo dentro de esa transaccion.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, EscenarioNotif } from "./notificaciones-soporte";

const SQL_0046 = readFileSync(
  fileURLToPath(new URL("../../packages/db/migrations/0046_notificacion_ms_validada.sql", import.meta.url)),
  "utf8",
);
const CHECK = `"notificacion"."creada_en" = date_trunc('milliseconds', "notificacion"."creada_en")`;

let admin: Pool;
let en: EscenarioNotif;
let tenant: string;
let usuario: string;

beforeAll(async () => {
  admin = abrirAdmin(2);
  en = new EscenarioNotif(admin);
  tenant = (await en.estudio()).id;
  usuario = (await en.et.miembro(tenant, "contador")).id;
});
afterAll(async () => {
  await en?.limpiar();
  await admin?.end();
});

/** Resumen de la auditoria del estudio: conteo y md5 de todas sus filas. */
async function resumenAuditoria(c: PoolClient) {
  const r = await c.query<{ n: string; h: string | null }>(
    `select count(*)::text as n,
            md5(coalesce(string_agg(id::text || '|' || accion || '|' || ocurrida_en::text || '|' || datos::text, ',' order by id), '')) as h
       from auditoria where tenant_id = $1`,
    [tenant],
  );
  return r.rows[0]!;
}

/** Deja la BD como estaba antes de 0046: CHECK NOT VALID y una notificacion con microsegundos. Devuelve su id. */
async function estadoPrevio(c: PoolClient): Promise<string> {
  await c.query("alter table notificacion drop constraint notificacion_creada_en_ms");
  const id = randomUUID();
  await c.query(
    `insert into notificacion (id, tenant_id, usuario_id, tipo, params, clave_dedupe, creada_en)
     values ($1, $2, $3, 'trabajo_terminado', '{"tipoTrabajo":"prueba.eco","estado":"completado","motivo":null}'::jsonb, $4,
             date_trunc('milliseconds', now() - interval '1 hour') + interval '123 microseconds')`,
    [id, tenant, usuario, `prueba:${id}`],
  );
  // NOT VALID rige para toda fila nueva: se vuelve a poner despues de sembrar la fila con us, igual que quedo tras 0044.
  await c.query(`alter table notificacion add constraint notificacion_creada_en_ms check (${CHECK}) not valid`);
  return id;
}

/** Ejecuta `fn` dentro de una transaccion del superusuario que siempre se revierte. */
async function enRevertida(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await fn(c);
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

const validada = async (c: PoolClient) =>
  (await c.query<{ convalidated: boolean }>("select convalidated from pg_constraint where conname = 'notificacion_creada_en_ms'"))
    .rows[0]?.convalidated;
const trigger = async (c: PoolClient) =>
  (await c.query<{ tgenabled: string }>("select tgenabled from pg_trigger where tgname = 'notificacion_solo_leida'")).rows.map(
    (x) => x.tgenabled,
  );
const microsegundos = async (c: PoolClient, id: string) =>
  (await c.query<{ us: string }>("select (extract(microseconds from creada_en)::bigint % 1000)::text as us from notificacion where id = $1", [id]))
    .rows[0]!.us;

describe("migracion 0046: valida notificacion_creada_en_ms (DT-8, CA-10)", () => {
  it("con una fila de microsegundos: la trunca, valida el CHECK y deja el trigger habilitado", async () => {
    await enRevertida(async (c) => {
      const id = await estadoPrevio(c);
      expect(await validada(c)).toBe(false);
      expect(await microsegundos(c, id)).toBe("123");
      const antes = await resumenAuditoria(c);

      await c.query(SQL_0046);

      expect(await validada(c)).toBe(true);
      expect(await microsegundos(c, id)).toBe("0");
      expect(await trigger(c)).toEqual(["O"]);
      expect(await resumenAuditoria(c)).toEqual(antes);
      // auditoria sigue NOT VALID (0044): 0046 no la toca.
      const aud = await c.query("select convalidated from pg_constraint where conname = 'auditoria_ocurrida_en_ms'");
      expect(aud.rows[0]?.convalidated).toBe(false);
    });
  });

  it("tras migrar, el trigger sigue rechazando cambiar creada_en (42501) y marcar leida funciona", async () => {
    await enRevertida(async (c) => {
      const id = await estadoPrevio(c);
      await c.query(SQL_0046);

      await c.query("savepoint s");
      await expect(
        c.query("update notificacion set creada_en = creada_en + interval '1 millisecond' where id = $1", [id]),
      ).rejects.toMatchObject({ code: "42501", message: expect.stringContaining("solo se marca como leida") });
      await c.query("rollback to s");

      // Como el rol de la app, bajo RLS: la fila (antes con us) se marca leida sin que el CHECK ni el trigger se opongan.
      await c.query("set local role contapp_backend");
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenant, usuario]);
      const r = await c.query("update notificacion set leida_en = now() where id = $1", [id]);
      expect(r.rowCount).toBe(1);
      await c.query("reset role");
      expect((await c.query("select leida_en from notificacion where id = $1", [id])).rows[0]!.leida_en).toBeInstanceOf(Date);
    });
  });

  it("es idempotente: sin filas con microsegundos solo valida y una segunda ejecucion no cambia nada", async () => {
    await enRevertida(async (c) => {
      await c.query("alter table notificacion drop constraint notificacion_creada_en_ms");
      await c.query(`alter table notificacion add constraint notificacion_creada_en_ms check (${CHECK}) not valid`);
      await c.query(SQL_0046);
      expect(await validada(c)).toBe(true);
      await c.query(SQL_0046);
      expect(await validada(c)).toBe(true);
      expect(await trigger(c)).toEqual(["O"]);
    });
  });

  it("si falla a mitad no deja el trigger deshabilitado (el bloque DO es atomico)", async () => {
    await enRevertida(async (c) => {
      await estadoPrevio(c);
      // Una fila ajena con us que el UPDATE no podra corregir sin violar otra regla: forzamos el fallo con un CHECK imposible.
      await c.query("savepoint s");
      await c.query("alter table notificacion add constraint prueba_imposible check (creada_en < '2000-01-01') not valid");
      await expect(c.query(SQL_0046)).rejects.toMatchObject({ code: "23514" });
      await c.query("rollback to s");
      expect(await trigger(c)).toEqual(["O"]);
    });
  });
});
