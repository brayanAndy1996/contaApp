// Spec 025 (T11a): `proveedoresConReglaActiva`, la lectura del worker de los proveedores con regla activa de un cliente por la
// función acotada de 0063 (`reglas_proveedores_con_regla`). Contra la BD real como contapp_worker (y contapp_backend, sin EXECUTE),
// más una `tx` falsa para la traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "../client";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import type { Tx } from "../with-tenant";
import { AprendizajeRepoError, proveedoresConReglaActiva } from "./index";
import {
  abrirAdmin,
  abrirDb,
  exigirEntorno,
  sembrarEstudio,
  type ClienteSembrado,
  type Estudio,
} from "./soporte-prueba";

let admin: Pool;
let backend: ContappDb;
let worker: ContappDb;
let A: Estudio;
let B: Estudio;
let ca: ClienteSembrado; // cliente de A con reglas
let ca2: ClienteSembrado; // otro cliente de A
let cb: ClienteSembrado; // cliente de B

async function regla(
  e: Estudio,
  c: ClienteSembrado,
  docNumero: string,
  o: { docTipo?: string; activa?: boolean; eliminada?: boolean; periodo?: string } = {},
): Promise<void> {
  await admin.query(
    `insert into regla_aprendida (tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido,
       creada_por, actualizada_por, eliminada_en, eliminada_por)
     values ($1, $2, $3, $4, 'DNG', $5, 1, $6, $7, $7, case when $8::boolean then now() else null end,
             case when $8::boolean then $7::uuid else null end)`,
    [e.tenantId, c.id, o.docTipo ?? "6", docNumero, o.activa ?? true, o.periodo ?? "202609", e.dueno.id, o.eliminada ?? false],
  );
}

async function interruptor(e: Estudio, codigo: string, activa: boolean): Promise<void> {
  await admin.query(
    `insert into estudio_regla_motor (tenant_id, codigo, activa, actualizada_por) values ($1, $2, $3, $4)
     on conflict (tenant_id, codigo) do update set activa = excluded.activa`,
    [e.tenantId, codigo, activa, e.dueno.id],
  );
}

beforeAll(async () => {
  exigirEntorno();
  admin = abrirAdmin();
  backend = abrirDb("contapp_backend");
  worker = abrirDb("contapp_worker");
  A = await sembrarEstudio(admin);
  B = await sembrarEstudio(admin);
  ca = await A.nuevoCliente();
  ca2 = await A.nuevoCliente();
  cb = await B.nuevoCliente();
  await regla(A, ca, "20100000001");
  await regla(A, ca, "20100000002", { periodo: "202612" }); // aprendida después de cualquier descarga: cuenta igual
  await regla(A, ca, "12345678", { docTipo: "1" });
  await regla(A, ca, "20100000003", { activa: false });
  await regla(A, ca, "20100000004", { eliminada: true });
  await regla(A, ca2, "20100000005");
  await regla(B, cb, "20100000006");
}, 60_000);

afterAll(async () => {
  for (const e of [A, B]) {
    if (!e) continue;
    await admin.query("delete from estudio_regla_motor where tenant_id = $1", [e.tenantId]).catch(() => undefined);
    await e.limpiar().catch(() => undefined);
  }
  await backend?.close();
  await worker?.close();
  await admin?.end();
});

const comoWorker = <T>(fn: (tx: Tx) => Promise<T>, e: Estudio = A): Promise<T> =>
  worker.withTenant({ tenantId: e.tenantId }, fn);

const ordenar = (xs: { docTipo: string; docNumero: string }[]) =>
  [...xs].sort((a, b) => (a.docNumero < b.docNumero ? -1 : 1));

describe("proveedoresConReglaActiva (0063)", () => {
  it("devuelve solo las reglas vivas y activas del cliente, sea cual sea su periodo", async () => {
    const r = await comoWorker((tx) => proveedoresConReglaActiva(tx, ca.id));
    expect(ordenar(r)).toEqual([
      { docTipo: "6", docNumero: "20100000001" },
      { docTipo: "6", docNumero: "20100000002" },
      { docTipo: "1", docNumero: "12345678" },
    ].sort((a, b) => (a.docNumero < b.docNumero ? -1 : 1)));
  });

  it("con R-HIS apagado en el estudio devuelve lo mismo (no depende del interruptor)", async () => {
    await interruptor(A, "R-HIS", false);
    try {
      const r = await comoWorker((tx) => proveedoresConReglaActiva(tx, ca.id));
      expect(r.map((x) => x.docNumero).sort()).toEqual(["12345678", "20100000001", "20100000002"]);
    } finally {
      await interruptor(A, "R-HIS", true);
    }
  });

  it("no mezcla clientes ni estudios; un cliente ajeno, inexistente o un id que no es uuid dan vacío", async () => {
    expect(await comoWorker((tx) => proveedoresConReglaActiva(tx, ca2.id))).toEqual([
      { docTipo: "6", docNumero: "20100000005" },
    ]);
    expect(await comoWorker((tx) => proveedoresConReglaActiva(tx, cb.id))).toEqual([]);
    expect(await comoWorker((tx) => proveedoresConReglaActiva(tx, randomUUID()))).toEqual([]);
    expect(await comoWorker((tx) => proveedoresConReglaActiva(tx, "no-es-uuid"))).toEqual([]);
    expect(await comoWorker((tx) => proveedoresConReglaActiva(tx, cb.id), B)).toEqual([
      { docTipo: "6", docNumero: "20100000006" },
    ]);
  });

  it("el backend no tiene EXECUTE: 42501 como AprendizajeRepoError", async () => {
    let error: unknown;
    try {
      await backend.withTenant({ tenantId: A.tenantId, userId: A.dueno.id }, (tx) => proveedoresConReglaActiva(tx, ca.id));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AprendizajeRepoError);
    expect((error as AprendizajeRepoError).codigo).toBe("42501");
  });

  it("de un error de pg solo conserva el SQLSTATE, nunca el mensaje ni el detalle", async () => {
    const { tx, llamadas } = txFalso(errorPg("22023", "CANARIO-0063"));
    const e = await proveedoresConReglaActiva(tx, ca.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AprendizajeRepoError);
    expect((e as AprendizajeRepoError).codigo).toBe("22023");
    expect(JSON.stringify(e) + String((e as Error).message)).not.toContain("CANARIO");
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.valores).toEqual([ca.id]);
  });
});
