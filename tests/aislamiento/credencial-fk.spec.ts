// Spec 007b (T1, rojo): FK de credencial a cliente (D2, migración 0027). Antes de 0027 `credencial.cliente_id` no tenía FK
// (003 D2); ahora debe apuntar a un cliente del MISMO estudio y no puede quedar huérfana. Cada archivo crea sus estudios y
// clientes (EscenarioTrabajos) y los borra al final. Los sobres son bytes aleatorios sintéticos.
//
// Contrato que fija (T7): la FK se llama `credencial_cliente_fk` (como `asignacion_cliente_fk` y `job_registro_cliente_fk`),
// es compuesta (tenant_id, cliente_id) -> cliente(tenant_id, id), sin ON DELETE (borrar un cliente con credenciales falla
// con 23503) y se crea validada. RLS, grants por columna y el trigger de estado de 003/008 no cambian.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { intentar, type ContappDb } from "./soporte";
import {
  codigo,
  crearDb,
  EscenarioTrabajos,
  type ClientePrueba,
} from "./trabajos-soporte";

const FK = "credencial_cliente_fk";
const INSERT = `insert into credencial (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
                values ($1, $2, $3, $4, $5, $6, 'k1', 1)`;
const sobre = (): Buffer[] => [
  randomBytes(64),
  randomBytes(12),
  randomBytes(16),
  randomBytes(512),
];

let admin: Pool;
let et: EscenarioTrabajos;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;

beforeAll(async () => {
  admin = abrirAdmin(4);
  et = new EscenarioTrabajos(admin);
  X = (await et.estudio()).id;
  Y = (await et.estudio()).id;
  cx = await et.cliente(X);
  cy = await et.cliente(Y);
  backend = crearDb("contapp_backend", 3);
  worker = crearDb("contapp_worker", 3);
});
afterAll(async () => {
  await et?.limpiar();
  await backend?.close();
  await worker?.close();
  await admin?.end();
});

describe("007b D2 · la FK existe con la forma del plan", () => {
  it(`${FK}: (tenant_id, cliente_id) -> cliente(tenant_id, id), sin ON DELETE y validada`, async () => {
    const r = await admin.query(
      `select c.conname, c.confrelid::regclass::text as destino, c.convalidated, c.confdeltype, c.confupdtype,
              (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as columnas,
              (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.att) as destinos
         from pg_constraint c
        where c.conrelid = 'public.credencial'::regclass and c.contype = 'f' and c.conname = $1`,
      [FK],
    );
    expect(r.rows, `falta la FK ${FK} (migración 0027)`).toHaveLength(1);
    const f = r.rows[0];
    expect(f.destino).toBe("cliente");
    expect(f.columnas).toEqual(["tenant_id", "cliente_id"]);
    expect(f.destinos).toEqual(["tenant_id", "id"]);
    expect(f.convalidated).toBe(true);
    expect(f.confdeltype, "ON DELETE debe ser NO ACTION").toBe("a");
    expect(f.confupdtype, "ON UPDATE debe ser NO ACTION").toBe("a");
  });

  it("la credencial conserva sus otras FK (tenant) y solo gana esta", async () => {
    const r = await admin.query(
      `select c.conname, c.confrelid::regclass::text as destino from pg_constraint c
        where c.conrelid = 'public.credencial'::regclass and c.contype = 'f' order by c.conname`,
    );
    expect(r.rows.map((x) => [x.conname, x.destino])).toEqual([
      [FK, "cliente"],
      ["credencial_tenant_id_tenant_id_fk", "tenant"],
    ]);
  });
});

describe("007b D2 · no admite cliente inexistente ni de otro estudio (23503)", () => {
  it("contapp_backend: cliente inexistente -> 23503 y no queda fila", async () => {
    const inexistente = randomUUID();
    const i = await intentar(backend, { tenantId: X }, INSERT, [
      inexistente,
      "sol",
      ...sobre(),
    ]);
    expect(codigo(i)).toBe("23503");
    const n = await admin.query(
      "select count(*)::int as n from credencial where cliente_id = $1",
      [inexistente],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("contapp_backend: cliente de OTRO estudio (con el contexto del estudio X) -> 23503", async () => {
    const i = await intentar(backend, { tenantId: X }, INSERT, [
      cy.id,
      "sol",
      ...sobre(),
    ]);
    expect(codigo(i)).toBe("23503");
  });

  it("contapp_backend: el mismo cliente_id con el contexto de su propio estudio sí inserta (control)", async () => {
    const i = await intentar(backend, { tenantId: X }, INSERT, [
      cx.id,
      "sol",
      ...sobre(),
    ]);
    expect(i).toEqual({ ok: true, rowCount: 1 });
  });

  it("superusuario: tampoco admite cliente inexistente ni un tenant_id distinto del cliente (la FK es de la tabla, no de RLS)", async () => {
    // transacción manual con SAVEPOINT por intento: nada persiste
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      const probar = async (tenant: string, cliente: string) => {
        await c.query("SAVEPOINT p");
        try {
          await c.query(
            `insert into credencial (tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
             values ($1, $2, 'sol', $3, $4, $5, $6, 'k1', 1)`,
            [tenant, cliente, ...sobre()],
          );
          return "ok";
        } catch (e) {
          return (e as { code?: string }).code ?? "sin código";
        } finally {
          await c.query("ROLLBACK TO SAVEPOINT p");
        }
      };
      expect(await probar(X, randomUUID())).toBe("23503");
      expect(await probar(Y, cx.id), "cliente de X con tenant_id de Y").toBe(
        "23503",
      );
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("guardarSobre (upsert del backend) sobre un cliente inexistente falla con CredencialRepoError 23503", async () => {
    const guardarSobre = (await import("@contapp/db")).guardarSobre as (
      tx: unknown,
      a: object,
    ) => Promise<unknown>;
    await expect(
      backend.withTenant({ tenantId: X }, (tx) =>
        guardarSobre(tx, {
          clienteId: randomUUID(),
          tipo: "sol",
          sobre: {
            ciphertext: randomBytes(64),
            nonce: randomBytes(12),
            tag: randomBytes(16),
            dekEnvuelta: randomBytes(512),
            kekId: "k1",
            version: 1,
          },
        }),
      ),
    ).rejects.toMatchObject({ name: "CredencialRepoError", codigo: "23503" });
  });
});

describe("007b D2 · un cliente con credenciales no se puede borrar", () => {
  it("DELETE del cliente con credencial -> 23503 y el cliente y la credencial siguen", async () => {
    const c = await et.cliente(X);
    const credId = await et.credencial(X, c.id, "sol");
    const r = await admin
      .query("delete from cliente where id = $1", [c.id])
      .then(
        () => "ok",
        (e: { code?: string }) => e.code ?? "sin código",
      );
    expect(r).toBe("23503");
    expect(
      (await admin.query("select 1 from cliente where id = $1", [c.id]))
        .rowCount,
    ).toBe(1);
    expect(
      (await admin.query("select 1 from credencial where id = $1", [credId]))
        .rowCount,
    ).toBe(1);
  });

  it("control: sin credenciales el cliente sí se borra (dentro de una transacción que se revierte)", async () => {
    const c = await et.cliente(X);
    const conn = await admin.connect();
    try {
      await conn.query("BEGIN");
      const r = await conn.query("delete from cliente where id = $1", [c.id]);
      expect(r.rowCount).toBe(1);
    } finally {
      await conn.query("ROLLBACK").catch(() => undefined);
      conn.release();
    }
  });
});

describe("007b D2 · RLS, grants y trigger de 003/008 siguen intactos", () => {
  it("credencial: RLS habilitada y forzada con la política tenant_isolation", async () => {
    const t = await admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.credencial'::regclass",
    );
    expect(t.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    const p = await admin.query(
      "select polname from pg_policy where polrelid = 'public.credencial'::regclass",
    );
    expect(p.rows.map((x) => x.polname)).toEqual(["tenant_isolation"]);
  });

  it("el backend sigue sin leer el sobre y el worker sigue sin escribirlo", async () => {
    const priv = async (rol: string, priv: string, col: string) =>
      (
        await admin.query(
          "select has_column_privilege($1, 'public.credencial', $2, $3) as v",
          [rol, col, priv],
        )
      ).rows[0].v as boolean;
    for (const col of ["ciphertext", "nonce", "tag", "dek_envuelta"]) {
      expect(
        await priv("contapp_backend", "SELECT", col),
        `backend SELECT ${col}`,
      ).toBe(false);
      expect(
        await priv("contapp_worker", "SELECT", col),
        `worker SELECT ${col}`,
      ).toBe(true);
    }
    for (const col of ["ciphertext", "nonce", "tag"]) {
      expect(
        await priv("contapp_worker", "UPDATE", col),
        `worker UPDATE ${col}`,
      ).toBe(false);
    }
    for (const col of ["estado", "estado_motivo", "estado_at"]) {
      expect(
        await priv("contapp_backend", "SELECT", col),
        `backend SELECT ${col}`,
      ).toBe(true);
      expect(
        await priv("contapp_backend", "UPDATE", col),
        `backend UPDATE ${col}`,
      ).toBe(false);
      expect(
        await priv("contapp_worker", "UPDATE", col),
        `worker UPDATE ${col}`,
      ).toBe(true);
    }
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      const t = await admin.query(
        "select has_table_privilege($1, 'public.credencial', 'DELETE') as d, has_table_privilege($1, 'public.credencial', 'TRUNCATE') as t",
        [rol],
      );
      expect(t.rows[0], `${rol}: DELETE/TRUNCATE`).toEqual({
        d: false,
        t: false,
      });
    }
  });

  it("el aislamiento por estudio sigue: el estudio Y no ve las credenciales de X", async () => {
    await et.credencial(X, cx.id, "sire_api");
    const vistas = await backend.withTenant({ tenantId: Y }, (tx) =>
      tx.query("select id from credencial where cliente_id = $1", [cx.id]),
    );
    expect(vistas.rowCount).toBe(0);
  });

  it("el trigger sigue: reemplazar el ciphertext devuelve a 'configurada' (estado_at nuevo, motivo nulo)", async () => {
    const c = await et.cliente(X);
    const id = await et.credencial(X, c.id, "sol");
    await admin.query(
      "update credencial set estado = 'invalida', estado_motivo = 'credencial_invalida', estado_at = now() where id = $1",
      [id],
    );
    await backend.withTenant({ tenantId: X }, (tx) =>
      tx.query(
        "update credencial set ciphertext = $2 where cliente_id = $1 and tipo = 'sol'",
        [c.id, randomBytes(64)],
      ),
    );
    const fila = (
      await admin.query(
        "select estado, estado_motivo, estado_at from credencial where id = $1",
        [id],
      )
    ).rows[0];
    expect(fila.estado).toBe("configurada");
    expect(fila.estado_motivo).toBeNull();
    expect(fila.estado_at).toBeInstanceOf(Date);
  });
});
