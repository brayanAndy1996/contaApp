// CA-7 (mismo RUC en dos estudios, 01 §2): los UNIQUE de negocio incluyen tenant_id y no revelan existencia.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirPool,
  clientesDe,
  crearDb,
  intentar,
  otro,
  ROLES_APP,
  semilla,
  tenantDe,
  type ContappDb,
  type Estudio,
} from "./soporte";

describe("CA-7 restricciones UNIQUE en el catalogo", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = abrirPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("todo indice UNIQUE (no PK) de una tabla con tenant_id incluye tenant_id", async () => {
    const r = await pool.query(
      `select c.relname as tabla, i.relname as indice,
              array_agg(a.attname::text order by k.ord) as columnas
         from pg_index x
         join pg_class c on c.oid = x.indrelid
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         join pg_class i on i.oid = x.indexrelid
         cross join lateral unnest(x.indkey::int2[]) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
        where x.indisunique and not x.indisprimary
          and exists (select 1 from pg_attribute t
                       where t.attrelid = c.oid and t.attname = 'tenant_id' and not t.attisdropped)
        group by c.relname, i.relname`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    // 005: excepcion explicita: invitacion_token_hash_unique es global (sin tenant_id) por diseno del plan, porque
    // el token de 32 B es un secreto aleatorio y la aceptacion lo busca sin conocer el estudio. Cualquier otro
    // UNIQUE sin tenant_id sigue fallando.
    const EXCEPCIONES = ["invitacion.invitacion_token_hash_unique"];
    const sin = r.rows.filter(
      (x) => !(x.columnas as string[]).includes("tenant_id") && !EXCEPCIONES.includes(`${x.tabla}.${x.indice}`),
    );
    expect(sin.map((x) => `${x.tabla}.${x.indice}`)).toEqual([]);
    const ruc = r.rows.find((x) => x.tabla === "cliente" && (x.columnas as string[]).includes("ruc"));
    expect(ruc, "cliente debe tener UNIQUE sobre (tenant_id, ruc)").toBeDefined();
    expect((ruc!.columnas as string[]).slice().sort()).toEqual(["ruc", "tenant_id"]);
  });
});

describe.each(ROLES_APP)("CA-7 rol %s", (rolApp) => {
  let db: ContappDb;
  beforeAll(() => {
    db = crearDb(rolApp);
  });
  afterAll(async () => {
    await db?.close();
  });

  const rucs = (e: Estudio) => clientesDe(e).map((c) => c.ruc);

  it("el seed tiene el mismo RUC en A y en B, como filas distintas", async () => {
    const { rucRepetido } = semilla();
    const fila = async (e: Estudio) =>
      db.withTenant(
        { tenantId: tenantDe(e) },
        async (tx) => (await tx.query("select id, tenant_id from cliente where ruc = $1", [rucRepetido])).rows,
      );
    const a = await fila("A");
    const b = await fila("B");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].id).not.toBe(b[0].id);
    expect(a[0].tenant_id).toBe(tenantDe("A"));
    expect(b[0].tenant_id).toBe(tenantDe("B"));
  });

  describe.each([
    { yo: "A", ajeno: "B" },
    { yo: "B", ajeno: "A" },
  ] as { yo: Estudio; ajeno: Estudio }[])("insertar en $yo un RUC que solo existe en $ajeno", ({ yo, ajeno }) => {
    const rucSoloAjeno = () => {
      const ruc = rucs(ajeno).find((r) => !rucs(yo).includes(r));
      if (!ruc) throw new Error("el seed debe tener un RUC de cada estudio que no este en el otro");
      return ruc;
    };

    it("no falla y no revela su existencia", async () => {
      const r = await intentar(
        db,
        { tenantId: tenantDe(yo) },
        `insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, 'Mismo RUC, otro estudio')`,
        [tenantDe(yo), rucSoloAjeno()],
      );
      expect(r).toEqual({ ok: true, rowCount: 1 });
    });

    it("el estudio ajeno conserva exactamente su fila", async () => {
      const filas = await db.withTenant(
        { tenantId: tenantDe(ajeno) },
        async (tx) => (await tx.query("select id from cliente where ruc = $1", [rucSoloAjeno()])).rows,
      );
      expect(filas).toHaveLength(1);
      expect(filas[0].id).toBe(clientesDe(ajeno).find((c) => c.ruc === rucSoloAjeno())!.id);
    });
  });

  it("control: repetir un RUC dentro del mismo estudio si viola el UNIQUE (23505)", async () => {
    const r = await intentar(
      db,
      { tenantId: tenantDe("A") },
      `insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, 'Duplicado')`,
      [tenantDe("A"), clientesDe("A")[0].ruc],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("23505");
  });

  it("el rechazo por duplicado en el propio estudio no menciona al otro estudio", async () => {
    const r = await intentar(
      db,
      { tenantId: tenantDe("A") },
      `insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, 'Duplicado')`,
      [tenantDe("A"), clientesDe("A")[0].ruc],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(tenantDe(otro("A")));
  });
});
