// Spec 013 (T2, rojo): tablas `propuesta` (0028) y `propuesta_diferencia` (0029) contra la BD real (CA-3, CA-4; D1, D3, D4,
// D5, D15, D16). Hasta T8 fallan por falta de migracion: no existen las tablas. Cada archivo crea sus estudios y clientes
// (EscenarioVentas) y los borra al final.
//
// Contrato que fija (T8, plan.md "Contratos: tablas"):
//   propuesta(id, tenant_id, cliente_id, periodo char(6), libro compras|ventas, fuente api|importacion, hash char(64),
//     filas_recibidas, filas_nuevas, filas_iguales, filas_distintas, usuario_id, trabajo_id null, creada_en)
//     - unica (tenant_id, id) para las FK compuestas de venta y compra; FK compuesta (tenant_id, cliente_id) -> cliente
//     - CHECK recibidas = nuevas + iguales + distintas y recibidas <= 20.000
//   propuesta_diferencia(id, tenant_id, propuesta_id, clave, tipo, serie, numero, origen_existente sire|manual,
//     campos text[] no vacio, valores_sire jsonb) con FK compuesta (tenant_id, propuesta_id) -> propuesta(tenant_id, id)
//   RLS ENABLE + FORCE con `tenant_isolation`; los roles de la app (backend y worker) solo SELECT e INSERT: ni UPDATE, ni
//   DELETE, ni TRUNCATE (RNF-052, D4).
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import {
  abrirPool,
  filasRaw,
  intentar,
  intentarRaw,
  type ContappDb,
} from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import { contar, EscenarioVentas, HASH, PERIODO } from "./ventas-soporte";

const ROLES = ["contapp_backend", "contapp_worker"] as const;

let admin: Pool;
let app: Pool;
let ev: EscenarioVentas;
const dbs: Record<(typeof ROLES)[number], ContappDb> = {} as never;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let propX: string;
let propY: string;
// Si la siembra falla (rojo: faltan las tablas), las pruebas que la necesitan fallan con ese error y las de catalogo siguen.
let errSiembra: unknown;
const requiereSiembra = () => {
  if (errSiembra) throw errSiembra;
};

beforeAll(async () => {
  admin = abrirAdmin(6);
  app = abrirPool(2);
  ev = new EscenarioVentas(admin);
  X = (await ev.estudio()).id;
  Y = (await ev.estudio()).id;
  cx = await ev.cliente(X);
  cy = await ev.cliente(Y);
  ux = await ev.usuarioDe(X);
  for (const r of ROLES) dbs[r] = crearDb(r, 3);
  try {
    propX = await ev.propuesta(X, cx, { nuevas: 2 });
    propY = await ev.propuesta(Y, cy, { nuevas: 1 });
    await admin.query(
      `insert into propuesta_diferencia (tenant_id, propuesta_id, clave, tipo, serie, numero, origen_existente, campos, valores_sire)
       values ($1, $2, '03|B001|290', '03', 'B001', '290', 'sire', array['total'], '{"total":"120.00"}'::jsonb)`,
      [X, propX],
    );
  } catch (e) {
    errSiembra = e;
  }
});
afterAll(async () => {
  await ev?.limpiar();
  await Promise.all(Object.values(dbs).map((d) => d.close().catch(() => undefined)));
  await app?.end();
  await admin?.end();
});

const INSERT_PROPUESTA = `insert into propuesta (cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas,
  filas_iguales, filas_distintas, usuario_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`;
const propuestaVals = (
  cliente: string,
  o: Partial<{ libro: string; fuente: string; r: number; n: number; i: number; d: number }> = {},
) => [
  cliente,
  PERIODO,
  o.libro ?? "ventas",
  o.fuente ?? "api",
  HASH,
  o.r ?? 3,
  o.n ?? 1,
  o.i ?? 1,
  o.d ?? 1,
  ux,
];

// =================================================================================================
describe("0028/0029 · existen con las columnas del plan", () => {
  const columnas = async (tabla: string) =>
    (
      await admin.query(
        `select column_name, data_type, character_maximum_length as largo, is_nullable
           from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [tabla],
      )
    ).rows as { column_name: string; data_type: string; largo: number | null; is_nullable: string }[];

  it("propuesta tiene las 14 columnas del plan; trabajo_id es la unica opcional", async () => {
    const cols = await columnas("propuesta");
    expect(cols.map((c) => c.column_name).sort(), "falta la tabla propuesta (migracion 0028)").toEqual(
      [
        "id", "tenant_id", "cliente_id", "periodo", "libro", "fuente", "hash", "filas_recibidas", "filas_nuevas",
        "filas_iguales", "filas_distintas", "usuario_id", "trabajo_id", "creada_en",
      ].sort(),
    );
    const por = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(por.periodo.largo).toBe(6);
    expect(por.hash.largo).toBe(64);
    expect(cols.filter((c) => c.is_nullable === "YES").map((c) => c.column_name)).toEqual(["trabajo_id"]);
  });

  it("propuesta_diferencia tiene las columnas del plan; campos es text[] y valores_sire jsonb", async () => {
    const cols = await columnas("propuesta_diferencia");
    expect(
      cols.map((c) => c.column_name).sort(),
      "falta la tabla propuesta_diferencia (migracion 0029)",
    ).toEqual(
      [
        "id", "tenant_id", "propuesta_id", "clave", "tipo", "serie", "numero", "origen_existente", "campos",
        "valores_sire",
      ].sort(),
    );
    const por = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(por.campos.data_type).toBe("ARRAY");
    expect(por.valores_sire.data_type).toBe("jsonb");
  });
});

// =================================================================================================
describe("0028/0029 · RLS ENABLE + FORCE y prueba de catalogo de 002 (CA-4)", () => {
  for (const tabla of ["propuesta", "propuesta_diferencia"]) {
    it(`${tabla}: RLS habilitada y forzada, con tenant_isolation FOR ALL sobre app.tenant_id`, async () => {
      const t = await admin.query(
        `select c.relrowsecurity, c.relforcerowsecurity,
                exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id'
                          and a.attnotnull and not a.attisdropped) as tenant_not_null
           from pg_class c where c.oid = to_regclass('public.${tabla}')`,
      );
      expect(t.rows, `falta la tabla ${tabla}`).toHaveLength(1);
      expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true, tenant_not_null: true });
      const p = await admin.query(
        `select polname, polcmd, pg_get_expr(polqual, polrelid) as usando, pg_get_expr(polwithcheck, polrelid) as con_check
           from pg_policy where polrelid = to_regclass('public.${tabla}')`,
      );
      expect(p.rows.map((x) => x.polname)).toEqual(["tenant_isolation"]);
      expect(p.rows[0].polcmd, "FOR ALL").toBe("*");
      expect(p.rows[0].usando).toContain("app.tenant_id");
      expect(p.rows[0].con_check).toContain("app.tenant_id");
    });
  }

  it("el catalogo de 002 recorre las dos tablas (la prueba no es vacua)", async () => {
    const r = await admin.query(
      `select c.relname from pg_class c
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where c.relkind in ('r','p') and c.relnamespace = 'public'::regnamespace
          and c.relname in ('propuesta','propuesta_diferencia') order by 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual(["propuesta", "propuesta_diferencia"]);
  });
});

// =================================================================================================
describe("0028/0029 · aislamiento: sin contexto o con otro estudio, 0 filas (CA-4)", () => {
  beforeEach(requiereSiembra);
  for (const rol of ROLES) {
    it(`${rol}: el estudio Y no ve la propuesta ni la diferencia de X`, async () => {
      const p = await dbs[rol].withTenant({ tenantId: Y }, (tx) =>
        tx.query("select id from propuesta where id = $1", [propX]),
      );
      expect(p.rowCount).toBe(0);
      const d = await dbs[rol].withTenant({ tenantId: Y }, (tx) =>
        tx.query("select 1 from propuesta_diferencia where propuesta_id = $1", [propX]),
      );
      expect(d.rowCount).toBe(0);
    });

    it(`${rol}: el estudio X ve lo suyo y solo lo suyo`, async () => {
      const p = await dbs[rol].withTenant({ tenantId: X }, (tx) => tx.query("select id from propuesta"));
      expect(p.rows.map((r) => r.id)).toContain(propX);
      expect(p.rows.map((r) => r.id)).not.toContain(propY);
      const d = await dbs[rol].withTenant({ tenantId: X }, (tx) => tx.query("select * from propuesta_diferencia"));
      expect(d.rowCount).toBeGreaterThan(0);
    });

    it(`${rol}: sin app.tenant_id no hay filas (falla cerrado)`, async () => {
      const p = await filasRaw(app, rol, "select id from propuesta");
      const d = await filasRaw(app, rol, "select id from propuesta_diferencia");
      expect(p).toEqual([]);
      expect(d).toEqual([]);
    });

    it(`${rol}: no puede insertar para otro estudio (tenant_id ajeno) ni una propuesta de un cliente ajeno`, async () => {
      const ajeno = await intentar(
        dbs[rol],
        { tenantId: X },
        `insert into propuesta (tenant_id, cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas,
           filas_iguales, filas_distintas, usuario_id) values ($1, $2, $3, 'ventas', 'api', $4, 0, 0, 0, 0, $5)`,
        [Y, cx.id, PERIODO, HASH, ux],
      );
      expect(codigo(ajeno)).toBe("42501");
      const clienteAjeno = await intentar(dbs[rol], { tenantId: X }, INSERT_PROPUESTA, propuestaVals(cy.id));
      expect(codigo(clienteAjeno), "FK compuesta (tenant_id, cliente_id)").toBe("23503");
    });
  }
});

// =================================================================================================
describe("0028/0029 · FK compuestas y unica (tenant_id, id)", () => {
  beforeEach(requiereSiembra);
  const fks = async (tabla: string) =>
    (
      await admin.query(
        `select c.conname, c.confrelid::regclass::text as destino,
                (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(att, ord)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as columnas,
                (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(att, ord)
                   join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.att) as destinos
           from pg_constraint c where c.conrelid = to_regclass('public.${tabla}') and c.contype = 'f'`,
      )
    ).rows as { conname: string; destino: string; columnas: string[]; destinos: string[] }[];

  it("propuesta: FK compuesta (tenant_id, cliente_id) -> cliente(tenant_id, id)", async () => {
    const f = (await fks("propuesta")).find((x) => x.destino === "cliente");
    expect(f, "falta la FK de propuesta a cliente").toBeDefined();
    expect(f!.columnas).toEqual(["tenant_id", "cliente_id"]);
    expect(f!.destinos).toEqual(["tenant_id", "id"]);
  });

  it("propuesta tiene la unica (tenant_id, id) que usaran venta.propuesta_id y compra.propuesta_id", async () => {
    const r = await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas
         from pg_index i where i.indrelid = to_regclass('public.propuesta') and i.indisunique and not i.indisprimary`,
    );
    expect(r.rows.map((x) => x.columnas)).toContainEqual(["tenant_id", "id"]);
  });

  it("propuesta_diferencia: FK compuesta (tenant_id, propuesta_id) -> propuesta(tenant_id, id)", async () => {
    const f = (await fks("propuesta_diferencia")).find((x) => x.destino === "propuesta");
    expect(f, "falta la FK de la diferencia a propuesta").toBeDefined();
    expect(f!.columnas).toEqual(["tenant_id", "propuesta_id"]);
    expect(f!.destinos).toEqual(["tenant_id", "id"]);
  });

  it("una diferencia no puede colgar de la propuesta de otro estudio ni de una inexistente (23503)", async () => {
    const ins = `insert into propuesta_diferencia (propuesta_id, clave, tipo, serie, numero, origen_existente, campos, valores_sire)
                 values ($1, '03|B001|1', '03', 'B001', '1', 'sire', array['total'], '{"total":"1.00"}'::jsonb)`;
    expect(codigo(await intentar(dbs.contapp_worker, { tenantId: X }, ins, [propY]))).toBe("23503");
    expect(codigo(await intentar(dbs.contapp_worker, { tenantId: X }, ins, ["00000000-0000-4000-8000-000000000001"]))).toBe(
      "23503",
    );
    expect(codigo(await intentar(dbs.contapp_worker, { tenantId: X }, ins, [propX]))).toBe("ok");
  });
});

// =================================================================================================
describe("0028 · CHECK de propuesta (D16, D10)", () => {
  beforeEach(requiereSiembra);
  for (const rol of ROLES) {
    it(`${rol}: recibidas = nuevas + iguales + distintas (3 = 1+1+1 inserta; 5 vs 3 falla con 23514)`, async () => {
      const ok = await intentar(dbs[rol], { tenantId: X }, INSERT_PROPUESTA, propuestaVals(cx.id));
      expect(ok, "insertar una propuesta valida con el rol de la app").toEqual({ ok: true, rowCount: 1 });
      const mal = await intentar(dbs[rol], { tenantId: X }, INSERT_PROPUESTA, propuestaVals(cx.id, { r: 5 }));
      expect(codigo(mal)).toBe("23514");
      const mal2 = await intentar(dbs[rol], { tenantId: X }, INSERT_PROPUESTA, propuestaVals(cx.id, { r: 2 }));
      expect(codigo(mal2)).toBe("23514");
    });
  }

  it("recibidas <= 20.000: 20.000 inserta y 20.001 falla aunque la suma cuadre", async () => {
    const tope = await intentar(
      dbs.contapp_worker,
      { tenantId: X },
      INSERT_PROPUESTA,
      propuestaVals(cx.id, { r: 20000, n: 20000, i: 0, d: 0 }),
    );
    expect(tope).toEqual({ ok: true, rowCount: 1 });
    const sobre = await intentar(
      dbs.contapp_worker,
      { tenantId: X },
      INSERT_PROPUESTA,
      propuestaVals(cx.id, { r: 20001, n: 20001, i: 0, d: 0 }),
    );
    expect(codigo(sobre)).toBe("23514");
    const repartida = await intentar(
      dbs.contapp_worker,
      { tenantId: X },
      INSERT_PROPUESTA,
      propuestaVals(cx.id, { r: 20001, n: 10000, i: 5000, d: 5001 }),
    );
    expect(codigo(repartida)).toBe("23514");
  });

  it("libro y fuente solo admiten los valores del plan (23514)", async () => {
    for (const o of [{ libro: "diario" }, { libro: "" }, { fuente: "manual" }, { fuente: "" }]) {
      const i = await intentar(dbs.contapp_backend, { tenantId: X }, INSERT_PROPUESTA, propuestaVals(cx.id, o));
      expect(codigo(i), JSON.stringify(o)).toBe("23514");
    }
    for (const o of [{ libro: "compras" }, { libro: "ventas", fuente: "importacion" }]) {
      const i = await intentar(dbs.contapp_backend, { tenantId: X }, INSERT_PROPUESTA, propuestaVals(cx.id, o));
      expect(i, JSON.stringify(o)).toEqual({ ok: true, rowCount: 1 });
    }
  });

  it("trabajo_id puede ser nulo (importacion) y una propuesta no se puede insertar sin cliente ni usuario (23502)", async () => {
    const sinCliente = await intentar(dbs.contapp_backend, { tenantId: X }, INSERT_PROPUESTA, propuestaVals(null as never));
    expect(codigo(sinCliente)).toBe("23502");
    const sinUsuario = await intentar(dbs.contapp_backend, { tenantId: X }, INSERT_PROPUESTA, [
      ...propuestaVals(cx.id).slice(0, 9),
      null,
    ]);
    expect(codigo(sinUsuario)).toBe("23502");
  });
});

// =================================================================================================
describe("0029 · CHECK de propuesta_diferencia", () => {
  beforeEach(requiereSiembra);
  const INS = `insert into propuesta_diferencia (propuesta_id, clave, tipo, serie, numero, origen_existente, campos, valores_sire)
               values ($1, '03|B001|291', '03', 'B001', '291', $2, $3::text[], '{"total":"5.00"}'::jsonb)`;

  it("campos no puede ser vacio ni nulo; con un campo inserta", async () => {
    expect(codigo(await intentar(dbs.contapp_worker, { tenantId: X }, INS, [propX, "sire", "{}"]))).toBe("23514");
    expect(codigo(await intentar(dbs.contapp_worker, { tenantId: X }, INS, [propX, "sire", null]))).toBe("23502");
    expect(await intentar(dbs.contapp_worker, { tenantId: X }, INS, [propX, "sire", "{total}"])).toEqual({
      ok: true,
      rowCount: 1,
    });
  });

  it("origen_existente solo sire|manual (23514)", async () => {
    expect(codigo(await intentar(dbs.contapp_worker, { tenantId: X }, INS, [propX, "otro", "{total}"]))).toBe("23514");
    expect(await intentar(dbs.contapp_worker, { tenantId: X }, INS, [propX, "manual", "{total,igv}"])).toEqual({
      ok: true,
      rowCount: 1,
    });
  });
});

// =================================================================================================
describe("0028/0029 · inmutabilidad: solo SELECT e INSERT para los roles de la app (RNF-052, D4, CA-3)", () => {
  beforeEach(requiereSiembra);
  const TABLAS = ["propuesta", "propuesta_diferencia"];

  it("privilegios de tabla: SELECT e INSERT si; UPDATE, DELETE y TRUNCATE no (backend y worker)", async () => {
    for (const rol of ROLES) {
      for (const tabla of TABLAS) {
        const r = await admin.query(
          `select has_table_privilege($1::name, $2::text, 'SELECT') as s, has_table_privilege($1::name, $2::text, 'INSERT') as i,
                  has_table_privilege($1::name, $2::text, 'UPDATE') as u, has_table_privilege($1::name, $2::text, 'DELETE') as d,
                  has_table_privilege($1::name, $2::text, 'TRUNCATE') as t`,
          [rol, `public.${tabla}`],
        );
        expect(r.rows[0], `${rol} sobre ${tabla}`).toEqual({ s: true, i: true, u: false, d: false, t: false });
      }
    }
  });

  it("ninguna columna admite UPDATE para los roles de la app", async () => {
    for (const rol of ROLES) {
      for (const tabla of TABLAS) {
        const r = await admin.query(
          `select a.attname from pg_attribute a
            where a.attrelid = to_regclass($2::text) and a.attnum > 0 and not a.attisdropped
              and has_column_privilege($1::name, a.attrelid, a.attnum, 'UPDATE')`,
          [rol, `public.${tabla}`],
        );
        expect(r.rows.map((x) => x.attname), `${rol} UPDATE en ${tabla}`).toEqual([]);
      }
    }
  });

  for (const rol of ROLES) {
    it(`${rol}: UPDATE y DELETE de propuesta fallan con 42501 y la fila queda intacta`, async () => {
      const antes = (await admin.query("select * from propuesta where id = $1", [propX])).rows[0];
      expect(antes).toBeDefined();
      const u = await intentar(dbs[rol], { tenantId: X }, "update propuesta set filas_nuevas = filas_nuevas where id = $1", [propX]);
      expect(codigo(u)).toBe("42501");
      const u2 = await intentar(dbs[rol], { tenantId: X }, "update propuesta set hash = $2 where id = $1", [propX, "b".repeat(64)]);
      expect(codigo(u2)).toBe("42501");
      const d = await intentar(dbs[rol], { tenantId: X }, "delete from propuesta where id = $1", [propX]);
      expect(codigo(d)).toBe("42501");
      const despues = (await admin.query("select * from propuesta where id = $1", [propX])).rows[0];
      expect(despues).toEqual(antes);
    });

    it(`${rol}: UPDATE y DELETE de propuesta_diferencia fallan con 42501 y la fila queda intacta`, async () => {
      const antes = (await admin.query("select * from propuesta_diferencia where propuesta_id = $1 order by id", [propX])).rows;
      expect(antes.length).toBeGreaterThan(0);
      const u = await intentar(dbs[rol], { tenantId: X }, "update propuesta_diferencia set clave = 'x' where propuesta_id = $1", [propX]);
      expect(codigo(u)).toBe("42501");
      const d = await intentar(dbs[rol], { tenantId: X }, "delete from propuesta_diferencia where propuesta_id = $1", [propX]);
      expect(codigo(d)).toBe("42501");
      const t = await intentarRaw(app, rol, "truncate propuesta_diferencia");
      expect(codigo(t), "TRUNCATE no pasa por triggers: el rol no debe tener el privilegio").toBe("42501");
      expect(
        (await admin.query("select * from propuesta_diferencia where propuesta_id = $1 order by id", [propX])).rows,
      ).toEqual(antes);
    });
  }

  it("el conteo de propuestas del estudio no cambio por los intentos (control)", async () => {
    expect(await contar(admin, "propuesta", "id = $1", [propX])).toBe(1);
  });
});
