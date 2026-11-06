// Spec 013 (T2, rojo): tabla `venta` (0030) contra la BD real (CA-3, CA-4, CA-6, CA-8, CA-11; D1, D3, D4, D5, D14b, D15, D16,
// D17). Hasta T8 fallan por falta de migracion. Cada archivo crea sus estudios y clientes (EscenarioVentas).
//
// Contrato que fija (T8, plan.md "Contratos: tablas"):
//   venta(id, tenant_id, cliente_id, periodo char(6), propuesta_id null, origen sire|manual, clave, tipo char(2),
//     serie varchar(4), numero varchar(20), numero_n null, fecha date, tipo_doc_contraparte, doc_contraparte,
//     moneda PEN|USD, tipo_cambio null, base_gravada, igv, exonerada, inafecta, isc, icbper, otros, total NUMERIC(14,2),
//     creada_por null, creada_en)
//   - `propuesta_id` es nulo si y solo si origen = manual; FK compuesta (tenant_id, propuesta_id) -> propuesta(tenant_id, id)
//   - unica (tenant_id, cliente_id, periodo, clave) entre sire y manual (D17)
//   - trigger BEFORE UPDATE OR DELETE: rechaza todo UPDATE y todo DELETE salvo el DELETE de filas `manual` (D4); tambien
//     para el superusuario. Los roles de la app: INSERT/SELECT y DELETE (backend, para quitar una manual); sin TRUNCATE.
//   - RLS ENABLE + FORCE con tenant_isolation.
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { abrirPool, filasRaw, intentar, intentarRaw, type ContappDb } from "./soporte";
import { codigo, crearDb, probar, type ClientePrueba } from "./trabajos-soporte";
import { contar, EscenarioVentas, PERIODO } from "./ventas-soporte";

const ROLES = ["contapp_backend", "contapp_worker"] as const;

let admin: Pool;
let app: Pool;
let ev: EscenarioVentas;
const dbs: Record<(typeof ROLES)[number], ContappDb> = {} as never;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let propX: string;
let propY: string;
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
  cx2 = await ev.cliente(X);
  cy = await ev.cliente(Y);
  ux = await ev.usuarioDe(X);
  for (const r of ROLES) dbs[r] = crearDb(r, 6);
  try {
    propX = await ev.propuesta(X, cx, { nuevas: 1 });
    propY = await ev.propuesta(Y, cy, { nuevas: 1 });
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

const INS = `insert into venta (cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
  tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper, otros,
  total, creada_por) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
  $21, $22, $23) returning id`;

interface V {
  periodo: string;
  propuestaId: string | null;
  origen: string;
  clave: string;
  tipo: string;
  serie: string;
  numero: string;
  numeroN: number | null;
  fecha: string;
  moneda: string;
  tipoCambio: string | null;
  base: string;
  igv: string;
  total: string;
}
function vals(cliente: string, o: Partial<V> = {}, creadaPor: string | null = null): unknown[] {
  const numero = o.numero ?? "290";
  const serie = o.serie ?? "B001";
  const tipo = o.tipo ?? "03";
  return [
    cliente,
    o.periodo ?? PERIODO,
    o.propuestaId === undefined ? propX : o.propuestaId,
    o.origen ?? "sire",
    o.clave ?? `${tipo}|${serie}|${numero}`,
    tipo,
    serie,
    numero,
    o.numeroN === undefined ? Number(numero) : o.numeroN,
    o.fecha ?? "2026-10-05",
    "0",
    "-",
    o.moneda ?? "PEN",
    o.tipoCambio ?? null,
    o.base ?? "100.00",
    o.igv ?? "18.00",
    "0.00",
    "0.00",
    "0.00",
    "0.00",
    "0.00",
    o.total ?? "118.00",
    creadaPor,
  ];
}
const manual = (cliente: string, o: Partial<V> = {}) =>
  vals(cliente, { origen: "manual", propuestaId: null, ...o }, ux);

// =================================================================================================
describe("0030 · existe con las columnas y tipos del plan (D14b)", () => {
  it("columnas, tamanos y NUMERIC(14,2) en los ocho montos", async () => {
    const r = await admin.query(
      `select column_name, data_type, character_maximum_length as largo, numeric_precision as p, numeric_scale as s,
              is_nullable
         from information_schema.columns where table_schema = 'public' and table_name = 'venta'`,
    );
    const cols = r.rows as Record<string, any>[];
    expect(cols.map((c) => c.column_name).sort(), "falta la tabla venta (migracion 0030)").toEqual(
      [
        "id", "tenant_id", "cliente_id", "periodo", "propuesta_id", "origen", "clave", "tipo", "serie", "numero",
        "numero_n", "fecha", "tipo_doc_contraparte", "doc_contraparte", "moneda", "tipo_cambio", "base_gravada", "igv",
        "exonerada", "inafecta", "isc", "icbper", "otros", "total", "creada_por", "creada_en",
      ].sort(),
    );
    const por = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect([por.periodo.largo, por.tipo.largo, por.serie.largo, por.numero.largo]).toEqual([6, 2, 4, 20]);
    expect(por.fecha.data_type).toBe("date");
    for (const m of ["base_gravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"]) {
      expect([por[m].data_type, por[m].p, por[m].s, por[m].is_nullable], m).toEqual(["numeric", 14, 2, "NO"]);
    }
    expect(por.tipo_cambio.data_type).toBe("numeric");
    expect(por.tipo_cambio.is_nullable).toBe("YES");
    expect(por.propuesta_id.is_nullable).toBe("YES");
    expect(por.numero_n.is_nullable).toBe("YES");
    expect(por.creada_por.is_nullable).toBe("YES");
  });

  it("el indice de lectura (cliente_id, periodo, tipo, serie, numero_n) existe", async () => {
    const r = await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas
         from pg_index i where i.indrelid = to_regclass('public.venta')`,
    );
    expect(r.rows.map((x) => x.columnas)).toContainEqual(["cliente_id", "periodo", "tipo", "serie", "numero_n"]);
  });
});

// =================================================================================================
describe("0030 · RLS ENABLE + FORCE y catalogo de 002 (CA-4)", () => {
  it("venta: RLS habilitada y forzada con tenant_isolation FOR ALL sobre app.tenant_id", async () => {
    const t = await admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = to_regclass('public.venta')",
    );
    expect(t.rows, "falta la tabla venta").toHaveLength(1);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const p = await admin.query(
      `select polname, polcmd, pg_get_expr(polqual, polrelid) as usando, pg_get_expr(polwithcheck, polrelid) as con_check
         from pg_policy where polrelid = to_regclass('public.venta')`,
    );
    expect(p.rows.map((x) => x.polname)).toEqual(["tenant_isolation"]);
    expect(p.rows[0].polcmd).toBe("*");
    expect(p.rows[0].usando).toContain("app.tenant_id");
    expect(p.rows[0].con_check).toContain("app.tenant_id");
  });

  it("el catalogo de 002 recorre venta (tiene tenant_id NOT NULL)", async () => {
    const r = await admin.query(
      `select a.attnotnull from pg_class c
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where c.relname = 'venta' and c.relnamespace = 'public'::regnamespace`,
    );
    expect(r.rows).toEqual([{ attnotnull: true }]);
  });
});

// =================================================================================================
describe("0030 · aislamiento por estudio (CA-4)", () => {
  beforeEach(requiereSiembra);

  it("el otro estudio y la consulta sin contexto ven 0 filas; el propio estudio ve las suyas", async () => {
    const id = await ev.venta(X, cx, { numero: "1" });
    for (const rol of ROLES) {
      const propia = await dbs[rol].withTenant({ tenantId: X }, (tx) => tx.query("select id from venta where id = $1", [id]));
      expect(propia.rowCount, `${rol} en su estudio`).toBe(1);
      const ajena = await dbs[rol].withTenant({ tenantId: Y }, (tx) => tx.query("select id from venta where id = $1", [id]));
      expect(ajena.rowCount, `${rol} con el estudio ajeno`).toBe(0);
      expect(await filasRaw(app, rol, "select id from venta"), `${rol} sin contexto`).toEqual([]);
    }
  });

  it("no se puede insertar con el tenant_id de otro estudio (42501) ni para un cliente de otro estudio (23503)", async () => {
    const conTenantAjeno = await intentar(
      dbs.contapp_worker,
      { tenantId: X },
      `insert into venta (tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
         tipo_doc_contraparte, doc_contraparte, moneda, base_gravada, igv, exonerada, inafecta, isc, icbper, otros, total)
       values ($1, $2, $3, $4, 'sire', 'k', '03', 'B001', '1', 1, '2026-10-05', '0', '-', 'PEN', 0, 0, 0, 0, 0, 0, 0, 0)`,
      [Y, cy.id, PERIODO, propY],
    );
    expect(codigo(conTenantAjeno)).toBe("42501");
    const clienteAjeno = await intentar(dbs.contapp_worker, { tenantId: X }, INS, vals(cy.id, { numero: "2" }));
    expect(codigo(clienteAjeno), "FK compuesta (tenant_id, cliente_id)").toBe("23503");
  });
});

// =================================================================================================
describe("0030 · FK compuestas", () => {
  beforeEach(requiereSiembra);

  const fks = async () =>
    (
      await admin.query(
        `select c.confrelid::regclass::text as destino,
                (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(att, ord)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as columnas,
                (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(att, ord)
                   join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.att) as destinos
           from pg_constraint c where c.conrelid = to_regclass('public.venta') and c.contype = 'f'`,
      )
    ).rows as { destino: string; columnas: string[]; destinos: string[] }[];

  it("(tenant_id, cliente_id) -> cliente(tenant_id, id) y (tenant_id, propuesta_id) -> propuesta(tenant_id, id)", async () => {
    const f = await fks();
    const cliente = f.find((x) => x.destino === "cliente");
    const propuesta = f.find((x) => x.destino === "propuesta");
    expect(cliente, "falta la FK de venta a cliente").toBeDefined();
    expect([cliente!.columnas, cliente!.destinos]).toEqual([["tenant_id", "cliente_id"], ["tenant_id", "id"]]);
    expect(propuesta, "falta la FK compuesta de venta a propuesta (la reutiliza 014)").toBeDefined();
    expect([propuesta!.columnas, propuesta!.destinos]).toEqual([["tenant_id", "propuesta_id"], ["tenant_id", "id"]]);
  });

  it("una venta sire no puede apuntar a la propuesta de otro estudio ni a una inexistente (23503)", async () => {
    expect(codigo(await intentar(dbs.contapp_worker, { tenantId: X }, INS, vals(cx.id, { numero: "3", propuestaId: propY })))).toBe(
      "23503",
    );
    expect(
      codigo(
        await intentar(
          dbs.contapp_worker,
          { tenantId: X },
          INS,
          vals(cx.id, { numero: "3", propuestaId: "00000000-0000-4000-8000-000000000001" }),
        ),
      ),
    ).toBe("23503");
    expect(await intentar(dbs.contapp_worker, { tenantId: X }, INS, vals(cx.id, { numero: "3" }))).toEqual({ ok: true, rowCount: 1 });
  });

  it("un cliente con ventas no se puede borrar (la FK no tiene ON DELETE)", async () => {
    const c = await ev.cliente(X);
    await ev.venta(X, c, { numero: "10" });
    const r = await admin.query("delete from cliente where id = $1", [c.id]).then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "sin codigo",
    );
    expect(r).toBe("23503");
  });
});

// =================================================================================================
describe("0030 · CHECK: origen, propuesta_id, moneda y rangos", () => {
  beforeEach(requiereSiembra);

  it("propuesta_id es nulo si y solo si el origen es manual (23514 en los dos sentidos)", async () => {
    const w = dbs.contapp_worker;
    const b = dbs.contapp_backend;
    expect(await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "20" }))).toEqual({ ok: true, rowCount: 1 });
    expect(await intentar(b, { tenantId: X }, INS, manual(cx.id, { numero: "21" }))).toEqual({ ok: true, rowCount: 1 });
    const sireSinPropuesta = await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "22", propuestaId: null }));
    expect(codigo(sireSinPropuesta), "una fila sire necesita su propuesta").toBe("23514");
    const manualConPropuesta = await intentar(b, { tenantId: X }, INS, vals(cx.id, { numero: "23", origen: "manual", propuestaId: propX }, ux));
    expect(codigo(manualConPropuesta), "una fila manual no cuelga de una propuesta").toBe("23514");
  });

  it("origen y moneda solo admiten los valores del plan (23514)", async () => {
    const w = dbs.contapp_worker;
    expect(codigo(await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "30", origen: "api" })))).toBe("23514");
    expect(codigo(await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "31", moneda: "EUR" })))).toBe("23514");
    expect(codigo(await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "32", moneda: "pen" })))).toBe("23514");
    expect(await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "33", moneda: "USD", tipoCambio: "3.456" }))).toEqual({
      ok: true,
      rowCount: 1,
    });
  });

  it("los montos son NUMERIC(14,2): 999999999999.99 entra, 1000000000000.00 desborda (22003) y negativos entran (nota de credito)", async () => {
    const w = dbs.contapp_worker;
    const maximo = await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "40", total: "999999999999.99" }));
    expect(maximo).toEqual({ ok: true, rowCount: 1 });
    const sobre = await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "41", total: "1000000000000.00" }));
    expect(codigo(sobre)).toBe("22003");
    const nc = await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "42", tipo: "07", base: "-100.00", igv: "-18.00", total: "-118.00" }));
    expect(nc).toEqual({ ok: true, rowCount: 1 });
  });

  it("serie de mas de 4 caracteres y numero de mas de 20 no caben (22001)", async () => {
    const w = dbs.contapp_worker;
    expect(codigo(await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "50", serie: "B0011" })))).toBe("22001");
    expect(codigo(await intentar(w, { tenantId: X }, INS, vals(cx.id, { numero: "1".repeat(21), numeroN: null })))).toBe("22001");
  });

  it("numero_n nulo es valido (numero no evaluable) y la fila se lee con numero_n null", async () => {
    const r = await intentar(dbs.contapp_worker, { tenantId: X }, INS, vals(cx.id, { numero: "ABC12", numeroN: null }));
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });
});

// =================================================================================================
describe("0030 · unica (cliente, periodo, clave) (D17, CA-11)", () => {
  beforeEach(requiereSiembra);

  it("el indice unico cubre (tenant_id, cliente_id, periodo, clave)", async () => {
    const r = await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas, i.indpred is null as total
         from pg_index i where i.indrelid = to_regclass('public.venta') and i.indisunique and not i.indisprimary`,
    );
    expect(r.rows).toContainEqual({ columnas: ["tenant_id", "cliente_id", "periodo", "clave"], total: true });
  });

  it("la misma clave en el mismo cliente y periodo da 23505, sea sire o manual (tambien manual contra sire)", async () => {
    const c = await ev.cliente(X);
    const w = dbs.contapp_worker;
    const b = dbs.contapp_backend;
    expect(await intentar(w, { tenantId: X }, INS, vals(c.id, { numero: "290", propuestaId: propX }))).toEqual({ ok: true, rowCount: 1 });
    await ev.venta(X, c, { numero: "290", propuestaId: propX });
    const dupSire = await intentar(w, { tenantId: X }, INS, vals(c.id, { numero: "290" }));
    expect(codigo(dupSire)).toBe("23505");
    const dupManual = await intentar(b, { tenantId: X }, INS, manual(c.id, { numero: "290" }));
    expect(codigo(dupManual), "agregar a mano una clave que ya trajo el SIRE").toBe("23505");
  });

  it("la clave es la normalizada: no hay dos filas con la misma clave aunque el numero se escriba distinto", async () => {
    const c = await ev.cliente(X);
    await ev.venta(X, c, { numero: "00291", clave: "03|B001|291", propuestaId: propX });
    const otra = await intentar(dbs.contapp_backend, { tenantId: X }, INS, manual(c.id, { numero: "291", clave: "03|B001|291" }));
    expect(codigo(otra)).toBe("23505");
  });

  it("la misma clave en otro periodo, en otro cliente o en otro estudio es otra fila", async () => {
    const c = await ev.cliente(X);
    const w = dbs.contapp_worker;
    await ev.venta(X, c, { numero: "290", propuestaId: propX });
    expect(await intentar(w, { tenantId: X }, INS, vals(c.id, { numero: "290", periodo: "202609" }))).toEqual({ ok: true, rowCount: 1 });
    expect(await intentar(w, { tenantId: X }, INS, vals(cx2.id, { numero: "290" }))).toEqual({ ok: true, rowCount: 1 });
    expect(await intentar(w, { tenantId: Y }, INS, vals(cy.id, { numero: "290", propuestaId: propY }))).toEqual({ ok: true, rowCount: 1 });
  });

  it("30 rondas: dos inserciones simultaneas de la misma clave dejan una sola fila y la otra recibe 23505", async () => {
    const c = await ev.cliente(X);
    const b = dbs.contapp_backend;
    const w = dbs.contapp_worker;
    for (let ronda = 0; ronda < 30; ronda++) {
      const numero = String(1000 + ronda);
      const insertar = (db: ContappDb, v: unknown[]) =>
        db.withTenant({ tenantId: X }, (tx) => tx.query(INS, v));
      const r = await Promise.allSettled([
        insertar(b, manual(c.id, { numero })),
        insertar(b, manual(c.id, { numero })),
        insertar(w, vals(c.id, { numero, propuestaId: propX })),
      ]);
      const ok = r.filter((x) => x.status === "fulfilled");
      const mal = r.filter((x): x is PromiseRejectedResult => x.status === "rejected");
      expect(ok, `ronda ${ronda}: exactamente una gana`).toHaveLength(1);
      expect(
        mal.map((x) => (x.reason as { code?: string }).code),
        `ronda ${ronda}: las demas reciben 23505 (nunca 40P01)`,
      ).toEqual(["23505", "23505"]);
      expect(await contar(admin, "venta", "cliente_id = $1 and clave = $2", [c.id, `03|B001|${numero}`])).toBe(1);
    }
  });
});

// =================================================================================================
describe("0030 · inmutabilidad: trigger y grants (RNF-052, D4, CA-3)", () => {
  beforeEach(requiereSiembra);

  it("hay un trigger de fila BEFORE que cubre UPDATE y DELETE sobre venta", async () => {
    const r = await admin.query(
      `select bool_or((tgtype & 2) = 2) as antes, bool_and((tgtype & 1) = 1) as por_fila,
              bool_or((tgtype & 16) = 16) as upd, bool_or((tgtype & 8) = 8) as del, count(*)::int as n
         from pg_trigger where tgrelid = to_regclass('public.venta') and not tgisinternal`,
    );
    expect(r.rows[0].n, "falta el trigger de venta").toBeGreaterThan(0);
    expect(r.rows[0]).toMatchObject({ antes: true, por_fila: true, upd: true, del: true });
  });

  it("privilegios de tabla: SELECT e INSERT a ambos roles; DELETE al backend (quitar una manual); TRUNCATE a nadie", async () => {
    const p = async (rol: string, priv: string) =>
      (await admin.query("select has_table_privilege($1::name, 'public.venta', $2::text) as v", [rol, priv])).rows[0].v as boolean;
    for (const rol of ROLES) {
      expect(await p(rol, "SELECT"), `${rol} SELECT`).toBe(true);
      expect(await p(rol, "INSERT"), `${rol} INSERT`).toBe(true);
      expect(await p(rol, "TRUNCATE"), `${rol} TRUNCATE (no pasa por triggers)`).toBe(false);
    }
    expect(await p("contapp_backend", "DELETE")).toBe(true);
  });

  it("TRUNCATE con cualquiera de los dos roles falla con 42501 y no borra nada", async () => {
    const id = await ev.venta(X, cx, { numero: "60", propuestaId: propX });
    for (const rol of ROLES) expect(codigo(await intentarRaw(app, rol, "truncate venta"))).toBe("42501");
    expect(await contar(admin, "venta", "id = $1", [id])).toBe(1);
  });

  for (const rol of ROLES) {
    it(`${rol}: UPDATE y DELETE de una fila sire fallan y la fila queda intacta`, async () => {
      const id = await ev.venta(X, cx, { numero: "61", propuestaId: propX, montos: { total: "118.00" } });
      const antes = (await admin.query("select * from venta where id = $1", [id])).rows[0];
      const u = await intentar(dbs[rol], { tenantId: X }, "update venta set total = 1 where id = $1", [id]);
      expect(u.ok, "UPDATE de una fila sire").toBe(false);
      const u2 = await intentar(dbs[rol], { tenantId: X }, "update venta set origen = 'manual', propuesta_id = null where id = $1", [id]);
      expect(u2.ok, "convertir una fila sire en manual para poder borrarla").toBe(false);
      const d = await intentar(dbs[rol], { tenantId: X }, "delete from venta where id = $1", [id]);
      expect(d.ok, "DELETE de una fila sire").toBe(false);
      expect((await admin.query("select * from venta where id = $1", [id])).rows[0]).toEqual(antes);
    });
  }

  it("el superusuario tampoco puede modificar ni borrar una fila sire (lo impide el trigger, no solo los grants)", async () => {
    const id = await ev.venta(X, cx, { numero: "62", propuestaId: propX });
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      expect((await probar(c, "update venta set total = 1 where id = $1", [id])).ok).toBe(false);
      expect((await probar(c, "delete from venta where id = $1", [id])).ok).toBe(false);
      expect((await probar(c, "update venta set origen = 'manual' where id = $1", [id])).ok).toBe(false);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    expect(await contar(admin, "venta", "id = $1", [id])).toBe(1);
  });

  it("backend: DELETE de una fila manual funciona (CA-8: la agregada se puede quitar)", async () => {
    const id = await ev.venta(X, cx, { numero: "63", origen: "manual" });
    const d = await intentar(dbs.contapp_backend, { tenantId: X }, "delete from venta where id = $1", [id]);
    expect(d).toEqual({ ok: true, rowCount: 1 });
    // intentar() revierte; se repite confirmando
    await dbs.contapp_backend.withTenant({ tenantId: X }, (tx) => tx.query("delete from venta where id = $1", [id]));
    expect(await contar(admin, "venta", "id = $1", [id])).toBe(0);
  });

  it("backend: un DELETE masivo que incluye una fila sire falla entero (no borra ni las manuales)", async () => {
    const c = await ev.cliente(X);
    const m = await ev.venta(X, c, { numero: "70", origen: "manual" });
    const s = await ev.venta(X, c, { numero: "71", propuestaId: propX });
    const d = await intentar(dbs.contapp_backend, { tenantId: X }, "delete from venta where cliente_id = $1", [c.id]);
    expect(d.ok).toBe(false);
    expect(await contar(admin, "venta", "id = any($1::uuid[])", [[m, s]])).toBe(2);
  });

  it("backend: el UPDATE de una fila manual tampoco esta permitido (la agregada no se edita; se quita y se vuelve a agregar)", async () => {
    const id = await ev.venta(X, cx, { numero: "64", origen: "manual", montos: { total: "118.00" } });
    const u = await intentar(dbs.contapp_backend, { tenantId: X }, "update venta set total = 1 where id = $1", [id]);
    expect(u.ok).toBe(false);
    const u2 = await intentar(dbs.contapp_backend, { tenantId: X }, "update venta set clave = 'otra' where id = $1", [id]);
    expect(u2.ok).toBe(false);
    expect((await admin.query("select total from venta where id = $1", [id])).rows[0].total).toBe("118.00");
  });

  it("backend: el estudio Y no puede borrar la fila manual de X (RLS: 0 filas, sin error de datos)", async () => {
    const id = await ev.venta(X, cx, { numero: "65", origen: "manual" });
    const r = await dbs.contapp_backend.withTenant({ tenantId: Y }, (tx) => tx.query("delete from venta where id = $1", [id]));
    expect(r.rowCount).toBe(0);
    expect(await contar(admin, "venta", "id = $1", [id])).toBe(1);
  });
});
