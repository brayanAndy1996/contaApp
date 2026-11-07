// Spec 013 (T2, rojo): tabla `venta_salto_justificado` (0031) contra la BD real (CA-4, CA-7; D5, D8, D15). Hasta T8 fallan
// por falta de migracion. Cada archivo crea sus estudios y clientes (EscenarioVentas).
//
// Contrato que fija (T8, plan.md "Contratos: tablas"):
//   venta_salto_justificado(id, tenant_id, cliente_id, periodo, tipo, serie, desde, hasta, comentario, usuario_id,
//     creada_en, revertido_por null, revertido_en null)
//   - desde y hasta enteros de 1 a 8 digitos, desde <= hasta; comentario de 1 a 500 caracteres
//   - unica PARCIAL (tenant_id, cliente_id, periodo, tipo, serie, desde, hasta) WHERE revertido_en IS NULL
//   - revertir solo escribe `revertido_por` y `revertido_en`: el rol backend tiene UPDATE unicamente sobre esas columnas
//     y no tiene DELETE ni TRUNCATE; el registro de una justificacion revertida se conserva (trazabilidad hasta 017)
//   - FK compuesta (tenant_id, cliente_id) -> cliente; RLS ENABLE + FORCE con tenant_isolation
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { abrirPool, filasRaw, intentar, intentarRaw, type ContappDb } from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import { contar, EscenarioVentas, PERIODO } from "./ventas-soporte";

let admin: Pool;
let app: Pool;
let ev: EscenarioVentas;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let uy: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  app = abrirPool(2);
  ev = new EscenarioVentas(admin);
  X = (await ev.estudio()).id;
  Y = (await ev.estudio()).id;
  cx = await ev.cliente(X);
  cy = await ev.cliente(Y);
  ux = await ev.usuarioDe(X);
  uy = await ev.usuarioDe(Y);
  backend = crearDb("contapp_backend", 6);
  worker = crearDb("contapp_worker", 3);
});
afterAll(async () => {
  await ev?.limpiar();
  await backend?.close();
  await worker?.close();
  await app?.end();
  await admin?.end();
});

const INS = `insert into venta_salto_justificado (cliente_id, periodo, tipo, serie, desde, hasta, comentario, usuario_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`;
const v = (
  cliente: string,
  usuario: string,
  o: Partial<{ periodo: string; tipo: string; serie: string; desde: number; hasta: number; comentario: string }> = {},
) => [cliente, o.periodo ?? PERIODO, o.tipo ?? "03", o.serie ?? "B001", o.desde ?? 291, o.hasta ?? 291, "comentario" in o ? o.comentario : "Boleta anulada en caja", usuario];

// =================================================================================================
describe("0031 · existe con las columnas del plan", () => {
  it("columnas, comentario no nulo y solo revertido_* opcionales", async () => {
    const r = await admin.query(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'venta_salto_justificado'`,
    );
    const cols = r.rows as { column_name: string; data_type: string; is_nullable: string }[];
    expect(
      cols.map((c) => c.column_name).sort(),
      "falta la tabla venta_salto_justificado (migracion 0031)",
    ).toEqual(
      [
        "id", "tenant_id", "cliente_id", "periodo", "tipo", "serie", "desde", "hasta", "comentario", "usuario_id",
        "creada_en", "revertido_por", "revertido_en",
      ].sort(),
    );
    expect(cols.filter((c) => c.is_nullable === "YES").map((c) => c.column_name).sort()).toEqual(["revertido_en", "revertido_por"]);
    const por = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(["integer", "bigint"]).toContain(por.desde.data_type);
    expect(por.hasta.data_type).toBe(por.desde.data_type);
  });
});

// =================================================================================================
describe("0031 · RLS ENABLE + FORCE y catalogo de 002 (CA-4)", () => {
  it("RLS habilitada y forzada con tenant_isolation FOR ALL sobre app.tenant_id", async () => {
    const t = await admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = to_regclass('public.venta_salto_justificado')",
    );
    expect(t.rows, "falta la tabla").toHaveLength(1);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const p = await admin.query(
      `select polname, polcmd, pg_get_expr(polqual, polrelid) as usando, pg_get_expr(polwithcheck, polrelid) as con_check
         from pg_policy where polrelid = to_regclass('public.venta_salto_justificado')`,
    );
    expect(p.rows.map((x) => x.polname)).toEqual(["tenant_isolation"]);
    expect(p.rows[0].polcmd).toBe("*");
    expect(p.rows[0].usando).toContain("app.tenant_id");
    expect(p.rows[0].con_check).toContain("app.tenant_id");
  });

  it("FK compuesta (tenant_id, cliente_id) -> cliente(tenant_id, id)", async () => {
    const r = await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as columnas,
              (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.att) as destinos
         from pg_constraint c
        where c.conrelid = to_regclass('public.venta_salto_justificado') and c.contype = 'f' and c.confrelid = 'public.cliente'::regclass`,
    );
    expect(r.rows, "falta la FK a cliente").toHaveLength(1);
    expect([r.rows[0].columnas, r.rows[0].destinos]).toEqual([["tenant_id", "cliente_id"], ["tenant_id", "id"]]);
  });
});

// =================================================================================================
describe("0031 · aislamiento por estudio (CA-4)", () => {
  it("el otro estudio y la consulta sin contexto ven 0 filas; no se inserta para un cliente ajeno ni con tenant ajeno", async () => {
    const cz = await ev.cliente(X); // cliente propio: no deja una vigente 291-291 en cx
    const id = await ev.salto(X, cz.id);
    const propia = await backend.withTenant({ tenantId: X }, (tx) => tx.query("select id from venta_salto_justificado where id = $1", [id]));
    expect(propia.rowCount).toBe(1);
    const ajena = await backend.withTenant({ tenantId: Y }, (tx) => tx.query("select id from venta_salto_justificado where id = $1", [id]));
    expect(ajena.rowCount).toBe(0);
    expect(await filasRaw(app, "contapp_backend", "select id from venta_salto_justificado")).toEqual([]);
    expect(codigo(await intentar(backend, { tenantId: X }, INS, v(cy.id, ux)))).toBe("23503");
    const conTenantAjeno = await intentar(
      backend,
      { tenantId: X },
      `insert into venta_salto_justificado (tenant_id, cliente_id, periodo, tipo, serie, desde, hasta, comentario, usuario_id)
       values ($1, $2, $3, '03', 'B001', 1, 1, 'x', $4)`,
      [Y, cy.id, PERIODO, uy],
    );
    expect(codigo(conTenantAjeno)).toBe("42501");
  });

  it("el estudio Y no puede revertir una justificacion de X (0 filas)", async () => {
    const id = await ev.salto(X, cx.id, { desde: 5, hasta: 5 });
    const r = await backend.withTenant({ tenantId: Y }, (tx) =>
      tx.query("update venta_salto_justificado set revertido_por = $2, revertido_en = now() where id = $1", [id, uy]),
    );
    expect(r.rowCount).toBe(0);
    expect(await contar(admin, "venta_salto_justificado", "id = $1 and revertido_en is null", [id])).toBe(1);
  });
});

// =================================================================================================
describe("0031 · CHECK: rango, enteros de 1 a 8 digitos y comentario 1 a 500 (D8)", () => {
  it("inserta el caso real (B001-291 con comentario) con el rol backend", async () => {
    const c = await ev.cliente(X);
    expect(await intentar(backend, { tenantId: X }, INS, v(c.id, ux))).toEqual({ ok: true, rowCount: 1 });
  });

  it("desde <= hasta: un rango invertido da 23514; desde = hasta y un rango amplio entran", async () => {
    expect(codigo(await intentar(backend, { tenantId: X }, INS, v(cx.id, ux, { desde: 295, hasta: 293 })))).toBe("23514");
    expect(await intentar(backend, { tenantId: X }, INS, v(cx.id, ux, { desde: 293, hasta: 295 }))).toEqual({ ok: true, rowCount: 1 });
    expect(await intentar(backend, { tenantId: X }, INS, v(cx.id, ux, { desde: 1, hasta: 99999999 }))).toEqual({ ok: true, rowCount: 1 });
  });

  it("desde y hasta de 1 a 8 digitos: 0, negativos y 100000000 (9 digitos) dan 23514", async () => {
    for (const [desde, hasta] of [
      [0, 5],
      [-3, 5],
      [1, 100000000],
      [100000000, 100000000],
    ]) {
      expect(codigo(await intentar(backend, { tenantId: X }, INS, v(cx.id, ux, { desde, hasta }))), `${desde}-${hasta}`).toBe("23514");
    }
  });

  it("comentario: vacio y de 501 caracteres dan 23514, nulo 23502; de 1 y de 500 entran", async () => {
    const c = await ev.cliente(X);
    expect(codigo(await intentar(backend, { tenantId: X }, INS, v(c.id, ux, { comentario: "" })))).toBe("23514");
    expect(codigo(await intentar(backend, { tenantId: X }, INS, v(c.id, ux, { comentario: "a".repeat(501) })))).toBe("23514");
    expect(codigo(await intentar(backend, { tenantId: X }, INS, v(c.id, ux, { comentario: null as never })))).toBe("23502");
    expect(await intentar(backend, { tenantId: X }, INS, v(c.id, ux, { comentario: "a", desde: 11, hasta: 11 }))).toEqual({ ok: true, rowCount: 1 });
    expect(await intentar(backend, { tenantId: X }, INS, v(c.id, ux, { comentario: "a".repeat(500), desde: 12, hasta: 12 }))).toEqual({ ok: true, rowCount: 1 });
  });

  it("comentario cuenta caracteres y no bytes: 500 letras con tilde entran", async () => {
    const c = await ev.cliente(X);
    expect(await intentar(backend, { tenantId: X }, INS, v(c.id, ux, { comentario: "ñ".repeat(500) }))).toEqual({ ok: true, rowCount: 1 });
  });
});

// =================================================================================================
describe("0031 · unica parcial entre vigentes (D8, CA-7)", () => {
  it("el indice unico parcial cubre (cliente, periodo, tipo, serie, desde, hasta) WHERE revertido_en IS NULL", async () => {
    const r = await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas,
              pg_get_expr(i.indpred, i.indrelid) as donde
         from pg_index i where i.indrelid = to_regclass('public.venta_salto_justificado') and i.indisunique and not i.indisprimary`,
    );
    const u = r.rows.find((x) => (x.columnas as string[]).includes("hasta"));
    expect(u, "falta la unica parcial de vigentes").toBeDefined();
    expect(u.columnas).toEqual(["tenant_id", "cliente_id", "periodo", "tipo", "serie", "desde", "hasta"]);
    expect(u.donde).toMatch(/revertido_en IS NULL/i);
  });

  it("dos vigentes iguales dan 23505; tras revertir la primera se puede justificar de nuevo; las revertidas se acumulan", async () => {
    const c = await ev.cliente(X);
    const a = await ev.salto(X, c.id, { desde: 291, hasta: 291 });
    expect(codigo(await intentar(backend, { tenantId: X }, INS, v(c.id, ux)))).toBe("23505");
    await admin.query("update venta_salto_justificado set revertido_por = $2, revertido_en = now() where id = $1", [a, ux]);
    const b = await backend.withTenant({ tenantId: X }, async (tx) => (await tx.query(INS, v(c.id, ux))).rows[0].id as string);
    await admin.query("update venta_salto_justificado set revertido_por = $2, revertido_en = now() where id = $1", [b, ux]);
    const cc = await backend.withTenant({ tenantId: X }, async (tx) => (await tx.query(INS, v(c.id, ux))).rows[0].id as string);
    expect(new Set([a, b, cc]).size).toBe(3);
    expect(await contar(admin, "venta_salto_justificado", "cliente_id = $1", [c.id])).toBe(3);
    expect(await contar(admin, "venta_salto_justificado", "cliente_id = $1 and revertido_en is null", [c.id])).toBe(1);
  });

  it("rangos distintos, otra serie, otro tipo, otro periodo u otro cliente no chocan", async () => {
    const c = await ev.cliente(X);
    await ev.salto(X, c.id, { desde: 291, hasta: 291 });
    for (const o of [{ desde: 291, hasta: 292 }, { desde: 290, hasta: 291 }, { serie: "B002" }, { tipo: "01" }, { periodo: "202609" }]) {
      expect(await intentar(backend, { tenantId: X }, INS, v(c.id, ux, o)), JSON.stringify(o)).toEqual({ ok: true, rowCount: 1 });
    }
    const otro = await ev.cliente(X);
    expect(await intentar(backend, { tenantId: X }, INS, v(otro.id, ux))).toEqual({ ok: true, rowCount: 1 });
  });

  it("30 rondas: dos justificaciones iguales a la vez dejan una sola vigente y la otra recibe 23505", async () => {
    const c = await ev.cliente(X);
    for (let ronda = 0; ronda < 30; ronda++) {
      const n = 5000 + ronda;
      const r = await Promise.allSettled([
        backend.withTenant({ tenantId: X }, (tx) => tx.query(INS, v(c.id, ux, { desde: n, hasta: n }))),
        backend.withTenant({ tenantId: X }, (tx) => tx.query(INS, v(c.id, ux, { desde: n, hasta: n }))),
      ]);
      expect(r.filter((x) => x.status === "fulfilled"), `ronda ${ronda}`).toHaveLength(1);
      const mal = r.find((x): x is PromiseRejectedResult => x.status === "rejected");
      expect((mal?.reason as { code?: string } | undefined)?.code, `ronda ${ronda}`).toBe("23505");
      expect(await contar(admin, "venta_salto_justificado", "cliente_id = $1 and desde = $2 and revertido_en is null", [c.id, n])).toBe(1);
    }
  });
});

// =================================================================================================
describe("0031 · revertir solo escribe revertido_* (D8, trazabilidad)", () => {
  it("columnas con UPDATE para el backend: exactamente revertido_por y revertido_en; el worker, ninguna distinta de esas", async () => {
    for (const [rol, exacto] of [
      ["contapp_backend", true],
      ["contapp_worker", false],
    ] as const) {
      const r = await admin.query(
        `select a.attname::text from pg_attribute a
          where a.attrelid = to_regclass('public.venta_salto_justificado') and a.attnum > 0 and not a.attisdropped
            and has_column_privilege($1::name, a.attrelid, a.attnum, 'UPDATE') order by 1`,
        [rol],
      );
      const cols = r.rows.map((x) => x.attname);
      if (exacto) expect(cols, `${rol} UPDATE`).toEqual(["revertido_en", "revertido_por"]);
      else expect(cols.filter((c) => !c.startsWith("revertido_")), `${rol} UPDATE`).toEqual([]);
    }
  });

  it("privilegios de tabla: el backend lee e inserta; nadie borra ni trunca", async () => {
    const p = async (rol: string, priv: string) =>
      (await admin.query("select has_table_privilege($1::name, 'public.venta_salto_justificado', $2::text) as v", [rol, priv])).rows[0]
        .v as boolean;
    expect(await p("contapp_backend", "SELECT")).toBe(true);
    expect(await p("contapp_backend", "INSERT")).toBe(true);
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      expect(await p(rol, "DELETE"), `${rol} DELETE`).toBe(false);
      expect(await p(rol, "TRUNCATE"), `${rol} TRUNCATE`).toBe(false);
    }
  });

  it("revertir con el backend funciona y deja el registro: quien y cuando, sin tocar lo demas", async () => {
    const c = await ev.cliente(X);
    const id = await ev.salto(X, c.id, { comentario: "Boleta anulada en caja" });
    const antes = (await admin.query("select * from venta_salto_justificado where id = $1", [id])).rows[0];
    await backend.withTenant({ tenantId: X }, (tx) =>
      tx.query("update venta_salto_justificado set revertido_por = $2, revertido_en = now() where id = $1 and revertido_en is null", [id, ux]),
    );
    const despues = (await admin.query("select * from venta_salto_justificado where id = $1", [id])).rows[0];
    expect(despues.revertido_por).toBe(ux);
    expect(despues.revertido_en).toBeInstanceOf(Date);
    const { revertido_por: _p, revertido_en: _e, ...restoAntes } = antes;
    const { revertido_por: _p2, revertido_en: _e2, ...restoDespues } = despues;
    expect(restoDespues).toEqual(restoAntes);
  });

  it("cambiar el comentario, el rango, la serie o el autor falla con 42501; DELETE y TRUNCATE tambien", async () => {
    const id = await ev.salto(X, cx.id, { desde: 7000, hasta: 7000 });
    for (const set of ["comentario = 'otro'", "desde = 1", "hasta = 9", "serie = 'B009'", "tipo = '01'", `usuario_id = '${uy}'`, "periodo = '202601'"]) {
      for (const db of [backend, worker]) {
        const r = await intentar(db, { tenantId: X }, `update venta_salto_justificado set ${set} where id = $1`, [id]);
        expect(codigo(r), set).toBe("42501");
      }
    }
    expect(codigo(await intentar(backend, { tenantId: X }, "delete from venta_salto_justificado where id = $1", [id]))).toBe("42501");
    expect(codigo(await intentarRaw(app, "contapp_backend", "truncate venta_salto_justificado"))).toBe("42501");
    expect(await contar(admin, "venta_salto_justificado", "id = $1 and comentario <> 'otro'", [id])).toBe(1);
  });
});
