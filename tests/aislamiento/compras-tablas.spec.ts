// Spec 014 (T6, rojo): las cinco tablas de compras (migraciones 0032 y 0033) contra la BD real. Cubre CA-2, CA-13 (parte de
// BD), D-1, D-2 y D-9. Hasta T11 fallan por tabla inexistente; cada archivo crea sus estudios y clientes (EscenarioCompras).
//
// Contrato de tablas que fija (plan.md «Contratos: BD», ajustado por 013: `creada_en`, ninguna columna `*_at`):
//   compra(id, tenant_id, cliente_id, periodo, propuesta_id null, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
//     razon_social null, fecha, moneda PEN|USD, tipo_cambio null, origen sire|agregada, version_vigente int, descartada_en null,
//     creada_en). propuesta_id NOT NULL si y solo si origen = sire; FK compuesta (tenant_id, propuesta_id) -> propuesta;
//     unico parcial (tenant_id, cliente_id, periodo, clave) WHERE descartada_en IS NULL; trigger BEFORE UPDATE: solo
//     version_vigente y descartada_en (de NULL a una fecha, una vez) son mutables, tambien para el superusuario.
//   compra_version(id, tenant_id, compra_id, n, 10 montos + total NUMERIC(14,2), excluida, motivo varchar(200) null, clasificada,
//     accion, operacion_id null, usuario_id null, creada_en); unico (compra_id, n); solo SELECT/INSERT.
//   compra_operacion(id, tenant_id, cliente_id, periodo, usuario_id, tipo, estado vigente|deshecha|caducada, referencia_id null,
//     creada_en, deshecha_en null); SELECT/INSERT y UPDATE solo de (estado, deshecha_en).
//   compra_hallazgo(id, tenant_id, compra_id, version_n, regla, sugerencia jsonb, lecturas jsonb, requiere_confirmacion,
//     creada_en); unico (compra_id, version_n, regla); solo SELECT/INSERT.
//   compra_periodo(tenant_id, cliente_id, periodo, estado abierto|revisado|generado, marcado_por null, marcado_en null);
//     PK (tenant_id, cliente_id, periodo); SELECT/INSERT y UPDATE de (estado, marcado_por, marcado_en); sin DELETE.
//   Las cinco: RLS ENABLE + FORCE con tenant_isolation, dueno contapp_migrator, sin DELETE ni TRUNCATE para los roles de la app.
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
import {
  codigo,
  crearDb,
  probar,
  type ClientePrueba,
} from "./trabajos-soporte";
import {
  barrera,
  contarFilas,
  COLUMNAS_SQL_MONTO,
  EscenarioCompras,
  INSERTAR_COMPRA,
  INSERTAR_VERSION,
  PERIODO,
  valoresCompra,
  valoresVersion,
} from "./compras-soporte";

const ROLES = ["contapp_backend", "contapp_worker"] as const;
const TABLAS = [
  "compra",
  "compra_version",
  "compra_operacion",
  "compra_hallazgo",
  "compra_periodo",
] as const;

let admin: Pool;
let app: Pool;
let ec: EscenarioCompras;
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
/**
 * T19 (H-014-6): siembra las versiones 2..`hasta` de una compra con el rol backend (INSERT, confirmadas) SIN mover el puntero.
 * El trigger exige que `version_vigente` apunte a una versión que exista (y hacia delante), así que toda prueba que mueva el
 * puntero tiene que sembrar antes la versión de destino.
 */
const conVersiones = (compraId: string, hasta: number) =>
  dbs.contapp_backend.withTenant({ tenantId: X }, async (tx) => {
    for (let n = 2; n <= hasta; n++) await tx.query(INSERTAR_VERSION, valoresVersion(compraId, n));
  });

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  ec = new EscenarioCompras(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cx2 = await ec.cliente(X);
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  for (const r of ROLES) dbs[r] = crearDb(r, 6);
  try {
    propX = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
    propY = await ec.propuesta(Y, cy, { libro: "compras", nuevas: 1 });
  } catch (e) {
    errSiembra = e;
  }
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    Object.values(dbs).map((d) => d.close().catch(() => undefined)),
  );
  await app?.end();
  await admin?.end();
});

const columnasDe = async (tabla: string) =>
  (
    await admin.query(
      `select column_name, data_type, character_maximum_length as largo, numeric_precision as p, numeric_scale as s,
              is_nullable
         from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [tabla],
    )
  ).rows as {
    column_name: string;
    data_type: string;
    largo: number | null;
    p: number | null;
    s: number | null;
    is_nullable: string;
  }[];

const privilegio = async (rol: string, tabla: string, priv: string) =>
  (
    await admin.query(
      "select has_table_privilege($1::name, $2::regclass, $3::text) as v",
      [rol, `public.${tabla}`, priv],
    )
  ).rows[0].v as boolean;
const privilegioColumna = async (
  rol: string,
  tabla: string,
  col: string,
  priv: string,
) =>
  (
    await admin.query(
      "select has_column_privilege($1::name, $2::regclass, $3::text, $4::text) as v",
      [rol, `public.${tabla}`, col, priv],
    )
  ).rows[0].v as boolean;
const algunaColumna = async (rol: string, tabla: string, priv: string) =>
  (
    await admin.query(
      "select has_any_column_privilege($1::name, $2::regclass, $3::text) as v",
      [rol, `public.${tabla}`, priv],
    )
  ).rows[0].v as boolean;

// =================================================================================================
describe("0032 y 0033 · columnas y tipos (D-1)", () => {
  const ESPERADAS: Record<string, string[]> = {
    compra: [
      "id",
      "tenant_id",
      "cliente_id",
      "periodo",
      "propuesta_id",
      "clave",
      "tipo_doc",
      "serie",
      "numero",
      "doc_tipo",
      "doc_numero",
      "razon_social",
      "fecha",
      "moneda",
      "tipo_cambio",
      "origen",
      "version_vigente",
      "descartada_en",
      "creada_en",
    ],
    compra_version: [
      "id",
      "tenant_id",
      "compra_id",
      "n",
      ...COLUMNAS_SQL_MONTO,
      "excluida",
      "motivo",
      "clasificada",
      "accion",
      "operacion_id",
      "usuario_id",
      "creada_en",
    ],
    compra_operacion: [
      "id",
      "tenant_id",
      "cliente_id",
      "periodo",
      "usuario_id",
      "tipo",
      "estado",
      "referencia_id",
      "creada_en",
      "deshecha_en",
    ],
    compra_hallazgo: [
      "id",
      "tenant_id",
      "compra_id",
      "version_n",
      "regla",
      "sugerencia",
      "lecturas",
      "requiere_confirmacion",
      "creada_en",
    ],
    compra_periodo: [
      "tenant_id",
      "cliente_id",
      "periodo",
      "estado",
      "marcado_por",
      "marcado_en",
    ],
  };

  for (const [tabla, esperadas] of Object.entries(ESPERADAS)) {
    it(`${tabla}: tiene todas las columnas del plan`, async () => {
      const nombres = (await columnasDe(tabla)).map((c) => c.column_name);
      expect(
        nombres,
        `falta la tabla ${tabla} (migracion 0032/0033)`,
      ).not.toHaveLength(0);
      expect(nombres).toEqual(expect.arrayContaining(esperadas));
    });
  }

  it("ninguna columna de las cinco tablas termina en _at (013 usa _en)", async () => {
    const r = await admin.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name = any($1::text[])`,
      [[...TABLAS]],
    );
    expect(new Set(r.rows.map((x) => x.table_name)), "faltan tablas").toEqual(
      new Set(TABLAS),
    );
    expect(r.rows.filter((x) => /_at$/.test(x.column_name))).toEqual([]);
  });

  it("compra_version: los 10 montos y el total son NUMERIC(14,2) NOT NULL; n y version_vigente son enteros; motivo hasta 200", async () => {
    const v = Object.fromEntries(
      (await columnasDe("compra_version")).map((c) => [c.column_name, c]),
    );
    expect(Object.keys(v), "falta compra_version").not.toHaveLength(0);
    for (const m of COLUMNAS_SQL_MONTO)
      expect([v[m]?.data_type, v[m]?.p, v[m]?.s, v[m]?.is_nullable], m).toEqual(
        ["numeric", 14, 2, "NO"],
      );
    expect(v.n.data_type).toBe("integer");
    expect(v.motivo.largo).toBe(200);
    expect(v.motivo.is_nullable).toBe("YES");
    expect([v.excluida.data_type, v.clasificada.data_type]).toEqual([
      "boolean",
      "boolean",
    ]);
    const c = Object.fromEntries(
      (await columnasDe("compra")).map((x) => [x.column_name, x]),
    );
    expect(c.version_vigente?.data_type).toBe("integer");
    expect(c.version_vigente?.is_nullable).toBe("NO");
    expect(c.propuesta_id?.is_nullable).toBe("YES");
    expect(c.tipo_cambio?.data_type).toBe("numeric");
    expect(c.descartada_en?.is_nullable).toBe("YES");
    expect(c.fecha?.data_type).toBe("date");
  });

  it("compra_hallazgo: sugerencia y lecturas son jsonb", async () => {
    const h = Object.fromEntries(
      (await columnasDe("compra_hallazgo")).map((c) => [c.column_name, c]),
    );
    expect([h.sugerencia?.data_type, h.lecturas?.data_type]).toEqual([
      "jsonb",
      "jsonb",
    ]);
    expect(h.requiere_confirmacion?.data_type).toBe("boolean");
  });

  it("compra_periodo: clave primaria (tenant_id, cliente_id, periodo)", async () => {
    const r = await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas
         from pg_index i where i.indrelid = to_regclass('public.compra_periodo') and i.indisprimary`,
    );
    expect(r.rows.map((x) => x.columnas)).toEqual([
      ["tenant_id", "cliente_id", "periodo"],
    ]);
  });
});

// =================================================================================================
describe("0032 y 0033 · RLS ENABLE + FORCE y catalogo de 002 (CA-13)", () => {
  for (const tabla of TABLAS) {
    it(`${tabla}: RLS habilitada y forzada con tenant_isolation FOR ALL sobre app.tenant_id, dueno contapp_migrator`, async () => {
      const t = await admin.query(
        `select c.relrowsecurity, c.relforcerowsecurity, o.rolname as dueno
           from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass($1)`,
        [`public.${tabla}`],
      );
      expect(t.rows, `falta la tabla ${tabla}`).toHaveLength(1);
      expect(t.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
        dueno: "contapp_migrator",
      });
      const p = await admin.query(
        `select polname, polcmd, pg_get_expr(polqual, polrelid) as usando, pg_get_expr(polwithcheck, polrelid) as con_check
           from pg_policy where polrelid = to_regclass($1)`,
        [`public.${tabla}`],
      );
      expect(p.rows.map((x) => x.polname)).toEqual(["tenant_isolation"]);
      expect(p.rows[0].polcmd).toBe("*");
      expect(p.rows[0].usando).toContain("app.tenant_id");
      expect(p.rows[0].con_check).toContain("app.tenant_id");
    });

    it(`${tabla}: el catalogo de 002 la recorre (tenant_id uuid NOT NULL)`, async () => {
      const r = await admin.query(
        `select a.attnotnull, t.typname from pg_class c
           join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
           join pg_type t on t.oid = a.atttypid
          where c.oid = to_regclass($1)`,
        [`public.${tabla}`],
      );
      expect(r.rows, `falta la tabla ${tabla}`).toEqual([
        { attnotnull: true, typname: "uuid" },
      ]);
    });
  }
});

// =================================================================================================
describe("0032 y 0033 · aislamiento por estudio (CA-13)", () => {
  beforeEach(requiereSiembra);

  it("el otro estudio y la consulta sin contexto ven 0 filas de las cinco tablas; el propio estudio ve las suyas", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    await admin.query(
      "insert into compra_hallazgo (tenant_id, compra_id, version_n, regla, sugerencia, lecturas, requiere_confirmacion) values ($1, $2, 1, 'R-X', '{}', '{}', false)",
      [X, c.id],
    );
    await ec.operacion(X, cx, { usuarioId: ux });
    await ec.estadoPeriodo(X, cx, PERIODO, "abierto");
    for (const rol of ROLES) {
      for (const tabla of TABLAS) {
        const propia = await dbs[rol].withTenant({ tenantId: X }, (tx) =>
          tx.query(`select 1 from ${tabla} where tenant_id = $1`, [X]),
        );
        expect(
          propia.rowCount,
          `${rol} ve ${tabla} de su estudio`,
        ).toBeGreaterThan(0);
        const ajena = await dbs[rol].withTenant({ tenantId: Y }, (tx) =>
          tx.query(`select 1 from ${tabla} where tenant_id = $1`, [X]),
        );
        expect(ajena.rowCount, `${rol} con el estudio ajeno en ${tabla}`).toBe(
          0,
        );
        expect(
          await filasRaw(app, rol, `select 1 from ${tabla}`),
          `${rol} sin contexto en ${tabla}`,
        ).toEqual([]);
      }
    }
  });

  it("no se puede insertar con el tenant_id de otro estudio (42501) ni para un cliente ajeno (23503)", async () => {
    const conTenantAjeno = await intentar(
      dbs.contapp_worker,
      { tenantId: X },
      `insert into compra (tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
         fecha, moneda, origen, version_vigente)
       values ($1, $2, $3, $4, 'k', '01', 'F001', '1', '6', '20100070970', '2026-10-05', 'PEN', 'sire', 1)`,
      [Y, cy.id, PERIODO, propY],
    );
    expect(codigo(conTenantAjeno)).toBe("42501");
    const clienteAjeno = await intentar(
      dbs.contapp_worker,
      { tenantId: X },
      INSERTAR_COMPRA,
      valoresCompra(cy.id, { propuestaId: propX }),
    );
    expect(codigo(clienteAjeno), "FK compuesta (tenant_id, cliente_id)").toBe(
      "23503",
    );
  });

  it("compra_periodo: no se puede escribir el estado de un cliente ajeno ni con otro tenant_id", async () => {
    const r = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      "insert into compra_periodo (cliente_id, periodo, estado) values ($1, $2, 'abierto')",
      [cy.id, PERIODO],
    );
    expect(codigo(r)).toBe("23503");
    const t = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      "insert into compra_periodo (tenant_id, cliente_id, periodo, estado) values ($1, $2, $3, 'abierto')",
      [Y, cy.id, PERIODO],
    );
    expect(codigo(t)).toBe("42501");
  });
});

// =================================================================================================
describe("0032 · FK compuestas (D-1)", () => {
  beforeEach(requiereSiembra);

  const fks = async (tabla: string) =>
    (
      await admin.query(
        `select c.confrelid::regclass::text as destino,
                (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(att, ord)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as columnas,
                (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(att, ord)
                   join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.att) as destinos
           from pg_constraint c where c.conrelid = to_regclass($1) and c.contype = 'f'`,
        [`public.${tabla}`],
      )
    ).rows as { destino: string; columnas: string[]; destinos: string[] }[];

  const exige = async (tabla: string, destino: string, col: string) => {
    const f = (await fks(tabla)).find(
      (x) => x.destino === destino && x.columnas.includes(col),
    );
    expect(f, `falta la FK de ${tabla}.${col} a ${destino}`).toBeDefined();
    expect([f!.columnas, f!.destinos]).toEqual([
      ["tenant_id", col],
      ["tenant_id", "id"],
    ]);
  };

  it("compra -> cliente y compra -> propuesta (compuestas con tenant_id)", async () => {
    await exige("compra", "cliente", "cliente_id");
    await exige("compra", "propuesta", "propuesta_id");
  });

  it("compra_version -> compra, compra_version -> compra_operacion, compra_hallazgo -> compra", async () => {
    await exige("compra_version", "compra", "compra_id");
    await exige("compra_version", "compra_operacion", "operacion_id");
    await exige("compra_hallazgo", "compra", "compra_id");
  });

  it("compra_operacion y compra_periodo -> cliente", async () => {
    await exige("compra_operacion", "cliente", "cliente_id");
    await exige("compra_periodo", "cliente", "cliente_id");
  });

  it("una compra sire no puede apuntar a la propuesta de otro estudio ni a una inexistente (23503)", async () => {
    const w = dbs.contapp_worker;
    expect(
      codigo(
        await intentar(
          w,
          { tenantId: X },
          INSERTAR_COMPRA,
          valoresCompra(cx.id, { numero: "3", propuestaId: propY }),
        ),
      ),
    ).toBe("23503");
    expect(
      codigo(
        await intentar(
          w,
          { tenantId: X },
          INSERTAR_COMPRA,
          valoresCompra(cx.id, {
            numero: "3",
            propuestaId: "00000000-0000-4000-8000-000000000001",
          }),
        ),
      ),
    ).toBe("23503");
    expect(
      await intentar(
        w,
        { tenantId: X },
        INSERTAR_COMPRA,
        valoresCompra(cx.id, { numero: "3", propuestaId: propX }),
      ),
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("una version no puede colgar de una compra de otro estudio (23503) y un cliente con compras no se puede borrar", async () => {
    const ajena = await ec.compra(Y, cy, { propuestaId: propY });
    const r = await intentar(
      dbs.contapp_worker,
      { tenantId: X },
      INSERTAR_VERSION,
      valoresVersion(ajena.id, 2),
    );
    expect(["23503", "42501"]).toContain(codigo(r));
    const c = await ec.cliente(X);
    await ec.compra(X, c, { propuestaId: propX });
    const del = await admin
      .query("delete from cliente where id = $1", [c.id])
      .then(
        () => "ok",
        (e: { code?: string }) => e.code ?? "sin codigo",
      );
    expect(del).toBe("23503");
  });
});

// =================================================================================================
describe("0032 · CHECK: origen, propuesta_id, moneda, periodo y rangos (D-1)", () => {
  beforeEach(requiereSiembra);
  const w = () => dbs.contapp_worker;
  const b = () => dbs.contapp_backend;

  it("propuesta_id es NOT NULL si y solo si el origen es sire (23514 en los dos sentidos)", async () => {
    expect(
      await intentar(
        w(),
        { tenantId: X },
        INSERTAR_COMPRA,
        valoresCompra(cx.id, { numero: "20", propuestaId: propX }),
      ),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(
      await intentar(
        b(),
        { tenantId: X },
        INSERTAR_COMPRA,
        valoresCompra(cx.id, {
          numero: "21",
          origen: "agregada",
          propuestaId: null,
        }),
      ),
    ).toEqual({
      ok: true,
      rowCount: 1,
    });
    const sireSinPropuesta = await intentar(
      w(),
      { tenantId: X },
      INSERTAR_COMPRA,
      valoresCompra(cx.id, { numero: "22", propuestaId: null }),
    );
    expect(
      codigo(sireSinPropuesta),
      "una fila sire necesita su propuesta",
    ).toBe("23514");
    const agregadaConPropuesta = await intentar(
      b(),
      { tenantId: X },
      INSERTAR_COMPRA,
      valoresCompra(cx.id, {
        numero: "23",
        origen: "agregada",
        propuestaId: propX,
      }),
    );
    expect(
      codigo(agregadaConPropuesta),
      "una agregada a mano no cuelga de una propuesta",
    ).toBe("23514");
  });

  it("origen solo admite sire y agregada (el origen manual de ventas no existe aqui), moneda PEN o USD y periodo AAAAMM (23514)", async () => {
    for (const origen of ["manual", "api", "SIRE"]) {
      expect(
        codigo(
          await intentar(
            w(),
            { tenantId: X },
            INSERTAR_COMPRA,
            valoresCompra(cx.id, { numero: "30", origen, propuestaId: propX }),
          ),
        ),
      ).toBe("23514");
    }
    expect(
      codigo(
        await intentar(
          w(),
          { tenantId: X },
          INSERTAR_COMPRA,
          valoresCompra(cx.id, {
            numero: "31",
            moneda: "EUR",
            propuestaId: propX,
          }),
        ),
      ),
    ).toBe("23514");
    expect(
      codigo(
        await intentar(
          w(),
          { tenantId: X },
          INSERTAR_COMPRA,
          valoresCompra(cx.id, {
            numero: "32",
            moneda: "pen",
            propuestaId: propX,
          }),
        ),
      ),
    ).toBe("23514");
    expect(
      codigo(
        await intentar(
          w(),
          { tenantId: X },
          INSERTAR_COMPRA,
          valoresCompra(cx.id, {
            numero: "33",
            periodo: "202613",
            propuestaId: propX,
          }),
        ),
      ),
    ).toBe("23514");
    expect(
      await intentar(
        w(),
        { tenantId: X },
        INSERTAR_COMPRA,
        valoresCompra(cx.id, {
          numero: "34",
          moneda: "USD",
          tipoCambio: "3.456",
          propuestaId: propX,
        }),
      ),
    ).toEqual({
      ok: true,
      rowCount: 1,
    });
  });

  it("los montos de la version son NUMERIC(14,2): 999999999999.99 entra, 1000000000000.00 desborda (22003) y los negativos entran (nota de credito)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const insertar = (
      n: number,
      total: string,
      extra: Record<string, string> = {},
    ) =>
      intentar(
        dbs.contapp_backend,
        { tenantId: X },
        INSERTAR_VERSION,
        valoresVersion(c.id, n, { montos: { biDg: total, total, ...extra } }),
      );
    expect(await insertar(2, "999999999999.99")).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(codigo(await insertar(2, "1000000000000.00"))).toBe("22003");
    expect(await insertar(2, "-118.00")).toEqual({ ok: true, rowCount: 1 });
  });

  it("el motivo admite 200 caracteres y no 201 (22001); el estado de la operacion y del periodo solo admiten los tres valores del plan (23514)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const b2 = dbs.contapp_backend;
    expect(
      await intentar(
        b2,
        { tenantId: X },
        INSERTAR_VERSION,
        valoresVersion(c.id, 2, { motivo: "a".repeat(200) }),
      ),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(
      codigo(
        await intentar(
          b2,
          { tenantId: X },
          INSERTAR_VERSION,
          valoresVersion(c.id, 2, { motivo: "a".repeat(201) }),
        ),
      ),
    ).toBe("22001");
    const op = (estado: string) =>
      intentar(
        b2,
        { tenantId: X },
        "insert into compra_operacion (cliente_id, periodo, usuario_id, tipo, estado) values ($1, $2, $3, 'editar', $4)",
        [cx.id, PERIODO, ux, estado],
      );
    for (const ok of ["vigente", "deshecha", "caducada"])
      expect(await op(ok), ok).toEqual({ ok: true, rowCount: 1 });
    expect(codigo(await op("rehecha"))).toBe("23514");
    const per = (estado: string, periodo: string) =>
      intentar(
        b2,
        { tenantId: X },
        "insert into compra_periodo (cliente_id, periodo, estado) values ($1, $2, $3)",
        [cx2.id, periodo, estado],
      );
    for (const [i, ok] of ["abierto", "revisado", "generado"].entries())
      expect(await per(ok, `20260${i + 1}`), ok).toEqual({
        ok: true,
        rowCount: 1,
      });
    expect(codigo(await per("cerrado", "202604"))).toBe("23514");
  });
});

// =================================================================================================
describe("0032 · clave unica entre filas vivas y liberada al descartar (D-1, D-7, CA-8)", () => {
  beforeEach(requiereSiembra);

  it("el indice unico es parcial: (tenant_id, cliente_id, periodo, clave) WHERE descartada_en IS NULL", async () => {
    const r = await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas,
              pg_get_expr(i.indpred, i.indrelid) as predicado
         from pg_index i where i.indrelid = to_regclass('public.compra') and i.indisunique and not i.indisprimary`,
    );
    const parcial = r.rows.find((x) => x.predicado !== null);
    expect(parcial, "falta el indice unico parcial de la clave").toBeDefined();
    expect(parcial.columnas).toEqual([
      "tenant_id",
      "cliente_id",
      "periodo",
      "clave",
    ]);
    expect(parcial.predicado).toMatch(/descartada_en IS NULL/i);
  });

  it("la misma clave viva en el mismo cliente y periodo da 23505, sea sire o agregada; en otro periodo, cliente o estudio es otra fila", async () => {
    const c = await ec.cliente(X);
    const w = dbs.contapp_worker;
    const b = dbs.contapp_backend;
    await ec.compra(X, c, { numero: "290", propuestaId: propX });
    expect(
      codigo(
        await intentar(
          w,
          { tenantId: X },
          INSERTAR_COMPRA,
          valoresCompra(c.id, { numero: "290", propuestaId: propX }),
        ),
      ),
    ).toBe("23505");
    expect(
      codigo(
        await intentar(
          b,
          { tenantId: X },
          INSERTAR_COMPRA,
          valoresCompra(c.id, { numero: "290", origen: "agregada" }),
        ),
      ),
    ).toBe("23505");
    expect(
      await intentar(
        w,
        { tenantId: X },
        INSERTAR_COMPRA,
        valoresCompra(c.id, {
          numero: "290",
          periodo: "202609",
          propuestaId: propX,
        }),
      ),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(
      await intentar(
        w,
        { tenantId: X },
        INSERTAR_COMPRA,
        valoresCompra(cx2.id, { numero: "290", propuestaId: propX }),
      ),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(
      await intentar(
        w,
        { tenantId: Y },
        INSERTAR_COMPRA,
        valoresCompra(cy.id, { numero: "290", propuestaId: propY }),
      ),
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("al descartar (descartada_en) la clave queda libre y se puede volver a agregar; la descartada sigue existiendo", async () => {
    const c = await ec.cliente(X);
    const a = await ec.compra(X, c, { numero: "55", origen: "agregada" });
    await dbs.contapp_backend.withTenant({ tenantId: X }, (tx) =>
      tx.query("update compra set descartada_en = now() where id = $1", [a.id]),
    );
    const otra = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      INSERTAR_COMPRA,
      valoresCompra(c.id, { numero: "55", origen: "agregada" }),
    );
    expect(otra).toEqual({ ok: true, rowCount: 1 });
    expect(
      await contarFilas(
        admin,
        "compra",
        "id = $1 and descartada_en is not null",
        [a.id],
      ),
    ).toBe(1);
  });

  it("30 rondas: dos inserciones simultaneas de la misma clave dejan una sola fila viva y la otra recibe 23505 (nunca 40P01)", async () => {
    const c = await ec.cliente(X);
    const b = dbs.contapp_backend;
    for (let ronda = 0; ronda < 30; ronda++) {
      const numero = String(1000 + ronda);
      const llegar = barrera(2);
      const insertar = () =>
        b.withTenant({ tenantId: X }, async (tx) => {
          await llegar();
          return tx.query(
            INSERTAR_COMPRA,
            valoresCompra(c.id, { numero, origen: "agregada" }),
          );
        });
      const r = await Promise.allSettled([insertar(), insertar()]);
      expect(
        r.filter((x) => x.status === "fulfilled"),
        `ronda ${ronda}: exactamente una gana`,
      ).toHaveLength(1);
      const mal = r.filter(
        (x): x is PromiseRejectedResult => x.status === "rejected",
      );
      expect(
        mal.map((x) => (x.reason as { code?: string }).code),
        `ronda ${ronda}`,
      ).toEqual(["23505"]);
    }
  });
});

// =================================================================================================
describe("0032 · compra_version: unica por (compra, n) (D-2)", () => {
  beforeEach(requiereSiembra);

  it("repetir (compra_id, n) da 23505; versiones consecutivas entran", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const b = dbs.contapp_backend;
    expect(
      codigo(
        await intentar(
          b,
          { tenantId: X },
          INSERTAR_VERSION,
          valoresVersion(c.id, 1),
        ),
      ),
    ).toBe("23505");
    expect(
      await intentar(
        b,
        { tenantId: X },
        INSERTAR_VERSION,
        valoresVersion(c.id, 2),
      ),
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("CAS del puntero: dos transacciones con version_vigente = 1 simultaneas, solo una cambia la fila", async () => {
    const b = dbs.contapp_backend;
    for (let ronda = 0; ronda < 15; ronda++) {
      const c = await ec.compra(X, cx, { propuestaId: propX });
      // T19 (H-014-6): el trigger exige que las versiones de destino existan; se siembran 2 y 3 sin mover el puntero.
      await conVersiones(c.id, 3);
      const llegar = barrera(2);
      const mover = (n: number) =>
        b.withTenant({ tenantId: X }, async (tx) => {
          await llegar();
          const r = await tx.query(
            "update compra set version_vigente = $2 where id = $1 and version_vigente = 1",
            [c.id, n],
          );
          return r.rowCount;
        });
      const filas = await Promise.all([mover(2), mover(3)]);
      expect(filas.sort(), `ronda ${ronda}`).toEqual([0, 1]);
    }
  });
});

// =================================================================================================
describe("0032 · inmutabilidad de la identidad: trigger y grants (RNF-052, D-1, CA-2)", () => {
  beforeEach(requiereSiembra);

  it("hay un trigger de fila BEFORE UPDATE en compra", async () => {
    const r = await admin.query(
      `select bool_or((tgtype & 2) = 2) as antes, bool_and((tgtype & 1) = 1) as por_fila, bool_or((tgtype & 16) = 16) as upd,
              count(*)::int as n
         from pg_trigger where tgrelid = to_regclass('public.compra') and not tgisinternal`,
    );
    expect(
      r.rows[0].n,
      "falta el trigger de identidad de compra",
    ).toBeGreaterThan(0);
    expect(r.rows[0]).toMatchObject({ antes: true, por_fila: true, upd: true });
  });

  const IDENTIDAD: [string, string][] = [
    ["id", "gen_random_uuid()"],
    ["tenant_id", "gen_random_uuid()"],
    ["cliente_id", "gen_random_uuid()"],
    ["periodo", "'202601'"],
    ["propuesta_id", "null"],
    ["clave", "'otra'"],
    ["tipo_doc", "'03'"],
    ["serie", "'B001'"],
    ["numero", "'9999'"],
    ["doc_tipo", "'1'"],
    ["doc_numero", "'10000000'"],
    ["razon_social", "'OTRA SAC'"],
    ["fecha", "'2026-01-01'"],
    ["moneda", "'USD'"],
    ["tipo_cambio", "3.5"],
    ["origen", "'agregada'"],
    ["creada_en", "now()"],
  ];

  for (const rol of ROLES) {
    it(`${rol}: UPDATE de cualquier columna de identidad de compra falla y la fila queda intacta`, async () => {
      const c = await ec.compra(X, cx, { propuestaId: propX });
      const antes = (
        await admin.query("select * from compra where id = $1", [c.id])
      ).rows[0];
      for (const [col, valor] of IDENTIDAD) {
        const u = await intentar(
          dbs[rol],
          { tenantId: X },
          `update compra set ${col} = ${valor} where id = $1`,
          [c.id],
        );
        expect(u.ok, `UPDATE de ${col}`).toBe(false);
      }
      expect(
        (await admin.query("select * from compra where id = $1", [c.id]))
          .rows[0],
      ).toEqual(antes);
    });
  }

  it("el superusuario tampoco puede cambiar la identidad (lo impide el trigger, no solo los grants), pero si mover el puntero", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    await conVersiones(c.id, 2); // T19 (H-014-6): el puntero solo se mueve a una versión que existe
    const cx1 = await admin.connect();
    try {
      await cx1.query("BEGIN");
      for (const [col, valor] of IDENTIDAD.filter(
        ([k]) => !["id", "tenant_id", "cliente_id", "propuesta_id"].includes(k),
      )) {
        expect(
          (
            await probar(
              cx1,
              `update compra set ${col} = ${valor} where id = $1`,
              [c.id],
            )
          ).ok,
          col,
        ).toBe(false);
      }
      expect(
        (
          await probar(
            cx1,
            "update compra set version_vigente = 2 where id = $1",
            [c.id],
          )
        ).ok,
      ).toBe(true);
    } finally {
      await cx1.query("ROLLBACK").catch(() => undefined);
      cx1.release();
    }
  });

  it("el backend mueve version_vigente y descarta (descartada_en de NULL a una fecha); no se puede deshacer ni cambiar la fecha", async () => {
    const c = await ec.compra(X, cx, { origen: "agregada" });
    // T19 (H-014-6): antes el puntero se movía a una versión 2 que no existía; ahora se siembra la versión 2 (la prueba sigue
    // demostrando lo mismo: el backend mueve el puntero con CAS y descarta una vez, y no puede deshacer ni cambiar la fecha).
    await conVersiones(c.id, 2);
    const b = dbs.contapp_backend;
    await b.withTenant({ tenantId: X }, async (tx) => {
      expect(
        (
          await tx.query(
            "update compra set version_vigente = 2 where id = $1 and version_vigente = 1",
            [c.id],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await tx.query(
            "update compra set descartada_en = '2026-10-10T10:00:00Z' where id = $1",
            [c.id],
          )
        ).rowCount,
      ).toBe(1);
    });
    expect(
      codigo(
        await intentar(
          b,
          { tenantId: X },
          "update compra set descartada_en = null where id = $1",
          [c.id],
        ),
      ),
      "reabrir una descartada",
    ).not.toBe("ok");
    expect(
      (
        await intentar(
          b,
          { tenantId: X },
          "update compra set descartada_en = now() where id = $1",
          [c.id],
        )
      ).ok,
      "mover la fecha",
    ).toBe(false);
    expect(
      (
        await admin.query(
          "select descartada_en is not null as d, version_vigente from compra where id = $1",
          [c.id],
        )
      ).rows[0],
    ).toEqual({
      d: true,
      version_vigente: 2,
    });
  });

  // ---- T19 · H-014-6 (rojo hasta T20): el trigger protege el puntero y el descarte, no solo la identidad ----------------------
  // Hasta hoy el CAS y estas reglas vivían solo en la aplicación: un UPDATE directo del rol backend podía (a) apuntar a una versión
  // inexistente (la compra desaparece de listado, resumen, Excel y 012b), (b) retroceder el puntero (cambia la vigente sin
  // versión, autor ni fecha, D-12) o (c) descartar una compra del SIRE (D-7: las del SIRE se excluyen, no se descartan).
  // `intentar` siempre revierte; los casos aceptados (control) prueban que el rechazo es por la regla y no por otra cosa.
  describe("H-014-6 · puntero version_vigente y descarte con UPDATE directo", () => {
    const mover = (compraId: string, hacia: number, desde?: number) =>
      intentar(
        dbs.contapp_backend,
        { tenantId: X },
        desde === undefined
          ? "update compra set version_vigente = $2 where id = $1"
          : "update compra set version_vigente = $2 where id = $1 and version_vigente = $3",
        desde === undefined ? [compraId, hacia] : [compraId, hacia, desde],
      );
    const puntero = async (compraId: string) =>
      (await admin.query("select version_vigente from compra where id = $1", [compraId])).rows[0].version_vigente as number;

    it("apuntar a una versión que no existe falla (la 2 con solo la 1; la 99 con la 1 y la 2) y el puntero no cambia", async () => {
      const c = await ec.compra(X, cx, { propuestaId: propX });
      expect((await mover(c.id, 2, 1)).ok, "versión 2 inexistente").toBe(false);
      await conVersiones(c.id, 2);
      expect((await mover(c.id, 99, 1)).ok, "versión 99 inexistente").toBe(false);
      expect(await puntero(c.id)).toBe(1);
    });

    it("control: avanzar a una versión que existe sí entra (con el CAS de la aplicación y sin él)", async () => {
      const c = await ec.compra(X, cx, { propuestaId: propX });
      await conVersiones(c.id, 3);
      expect(await mover(c.id, 2, 1)).toEqual({ ok: true, rowCount: 1 });
      expect(await mover(c.id, 3)).toEqual({ ok: true, rowCount: 1 });
    });

    it("la versión de OTRA compra no cuenta: la compra B con solo la versión 1 no puede apuntar a la 2 que tiene la A", async () => {
      const a = await ec.compra(X, cx, { propuestaId: propX });
      const b = await ec.compra(X, cx, { propuestaId: propX });
      await conVersiones(a.id, 2);
      expect((await mover(a.id, 2, 1)).ok, "control: la A sí").toBe(true);
      expect((await mover(b.id, 2, 1)).ok, "la B no").toBe(false);
    });

    it("retroceder el puntero (2 a 1, 3 a 2) falla y no deja versión, autor ni fecha: el puntero sigue donde estaba", async () => {
      const c = await ec.compra(X, cx, { propuestaId: propX });
      await conVersiones(c.id, 3);
      await dbs.contapp_backend.withTenant({ tenantId: X }, async (tx) => {
        await tx.query("update compra set version_vigente = 2 where id = $1 and version_vigente = 1", [c.id]);
      });
      expect((await mover(c.id, 1, 2)).ok, "2 a 1").toBe(false);
      expect((await mover(c.id, 1)).ok, "2 a 1 sin CAS").toBe(false);
      expect((await mover(c.id, 3, 2)).ok, "control: 2 a 3 sí").toBe(true);
      expect(await puntero(c.id)).toBe(2);
    });

    it("descartar una compra del SIRE falla (también para el superusuario); descartar una agregada sí (control) y la del SIRE queda viva", async () => {
      const sire = await ec.compra(X, cx, { propuestaId: propX });
      const agregada = await ec.compra(X, cx, { origen: "agregada" });
      const sql = "update compra set descartada_en = now() where id = $1";
      expect((await intentar(dbs.contapp_backend, { tenantId: X }, sql, [sire.id])).ok, "backend sobre el SIRE").toBe(false);
      const su = await admin.connect();
      try {
        await su.query("BEGIN");
        expect((await probar(su, sql, [sire.id])).ok, "superusuario sobre el SIRE").toBe(false);
        expect((await probar(su, sql, [agregada.id])).ok, "control: superusuario sobre la agregada").toBe(true);
      } finally {
        await su.query("ROLLBACK").catch(() => undefined);
        su.release();
      }
      expect((await intentar(dbs.contapp_backend, { tenantId: X }, sql, [agregada.id])).ok, "control: backend sobre la agregada").toBe(true);
      expect(await contarFilas(admin, "compra", "id = $1 and descartada_en is null", [sire.id])).toBe(1);
    });

    it("el superusuario tampoco apunta a una versión inexistente ni retrocede el puntero (lo impide el trigger, no solo los grants)", async () => {
      const c = await ec.compra(X, cx, { propuestaId: propX });
      await conVersiones(c.id, 2);
      const su = await admin.connect();
      try {
        await su.query("BEGIN");
        expect((await probar(su, "update compra set version_vigente = 99 where id = $1", [c.id])).ok, "a la 99").toBe(false);
        expect((await probar(su, "update compra set version_vigente = 2 where id = $1", [c.id])).ok, "control: a la 2").toBe(true);
        expect((await probar(su, "update compra set version_vigente = 1 where id = $1", [c.id])).ok, "hacia atrás").toBe(false);
      } finally {
        await su.query("ROLLBACK").catch(() => undefined);
        su.release();
      }
    });
  });

  it("privilegios de compra: SELECT/INSERT a ambos roles; UPDATE solo de (version_vigente, descartada_en) al backend; DELETE y TRUNCATE a nadie", async () => {
    for (const rol of ROLES) {
      expect(await privilegio(rol, "compra", "SELECT"), `${rol} SELECT`).toBe(
        true,
      );
      expect(await privilegio(rol, "compra", "INSERT"), `${rol} INSERT`).toBe(
        true,
      );
      expect(await privilegio(rol, "compra", "DELETE"), `${rol} DELETE`).toBe(
        false,
      );
      expect(
        await privilegio(rol, "compra", "TRUNCATE"),
        `${rol} TRUNCATE`,
      ).toBe(false);
    }
    for (const col of ["version_vigente", "descartada_en"])
      expect(
        await privilegioColumna("contapp_backend", "compra", col, "UPDATE"),
        col,
      ).toBe(true);
    for (const [col] of IDENTIDAD)
      expect(
        await privilegioColumna("contapp_backend", "compra", col, "UPDATE"),
        `identidad ${col}`,
      ).toBe(false);
    expect(
      await privilegioColumna(
        "contapp_worker",
        "compra",
        "razon_social",
        "UPDATE",
      ),
    ).toBe(false);
  });

  it("DELETE de una compra con cualquiera de los dos roles falla y no borra nada", async () => {
    const c = await ec.compra(X, cx, { origen: "agregada" });
    for (const rol of ROLES) {
      const d = await intentar(
        dbs[rol],
        { tenantId: X },
        "delete from compra where id = $1",
        [c.id],
      );
      expect(d.ok, `${rol} DELETE`).toBe(false);
      expect(
        codigo(await intentarRaw(app, rol, "truncate compra")),
        `${rol} TRUNCATE`,
      ).toBe("42501");
    }
    expect(await contarFilas(admin, "compra", "id = $1", [c.id])).toBe(1);
  });
});

// =================================================================================================
describe("0032 · version 1 inmutable y tablas de solo insercion (RNF-052, D-1, CA-2)", () => {
  beforeEach(requiereSiembra);

  it("privilegios: compra_version, compra_hallazgo y propuesta son SELECT/INSERT; ni UPDATE (de ninguna columna) ni DELETE ni TRUNCATE", async () => {
    for (const tabla of ["compra_version", "compra_hallazgo", "propuesta"]) {
      for (const rol of ROLES) {
        expect(
          await privilegio(rol, tabla, "SELECT"),
          `${rol} SELECT ${tabla}`,
        ).toBe(true);
        expect(
          await privilegio(rol, tabla, "INSERT"),
          `${rol} INSERT ${tabla}`,
        ).toBe(true);
        expect(
          await privilegio(rol, tabla, "DELETE"),
          `${rol} DELETE ${tabla}`,
        ).toBe(false);
        expect(
          await privilegio(rol, tabla, "TRUNCATE"),
          `${rol} TRUNCATE ${tabla}`,
        ).toBe(false);
        expect(
          await algunaColumna(rol, tabla, "UPDATE"),
          `${rol} UPDATE de alguna columna de ${tabla}`,
        ).toBe(false);
      }
    }
  });

  for (const rol of ROLES) {
    it(`${rol}: UPDATE y DELETE de la version 1 (o de cualquier version) fallan y la fila queda intacta`, async () => {
      const c = await ec.compra(X, cx, { propuestaId: propX });
      await ec.version(X, c.id, 2, {
        montos: { biDg: "900.00", igvDg: "162.00" },
      });
      const antes = (
        await admin.query(
          "select * from compra_version where compra_id = $1 order by n",
          [c.id],
        )
      ).rows;
      for (const sql of [
        "update compra_version set total = 1 where compra_id = $1 and n = 1",
        "update compra_version set bi_dg = 0 where compra_id = $1",
        "update compra_version set excluida = true where compra_id = $1",
        "update compra_version set n = n + 10 where compra_id = $1",
        "update compra_version set accion = 'otra' where compra_id = $1",
        "delete from compra_version where compra_id = $1 and n = 1",
        "delete from compra_version where compra_id = $1",
      ]) {
        const r = await intentar(dbs[rol], { tenantId: X }, sql, [c.id]);
        expect(r.ok, sql).toBe(false);
      }
      expect(
        (
          await admin.query(
            "select * from compra_version where compra_id = $1 order by n",
            [c.id],
          )
        ).rows,
      ).toEqual(antes);
    });

    it(`${rol}: UPDATE y DELETE sobre propuesta fallan (CA-2)`, async () => {
      const p = await ec.propuesta(X, cx, { libro: "compras", nuevas: 3 });
      for (const sql of [
        "update propuesta set filas_nuevas = 0 where id = $1",
        "update propuesta set hash = 'x' where id = $1",
        "delete from propuesta where id = $1",
      ]) {
        expect(
          (await intentar(dbs[rol], { tenantId: X }, sql, [p])).ok,
          sql,
        ).toBe(false);
      }
      expect(
        await contarFilas(admin, "propuesta", "id = $1 and filas_nuevas = 3", [
          p,
        ]),
      ).toBe(1);
    });
  }

  it("TRUNCATE de compra_version y de compra_hallazgo falla con 42501", async () => {
    for (const rol of ROLES) {
      for (const t of [
        "compra_version",
        "compra_hallazgo",
        "compra_operacion",
        "compra_periodo",
      ]) {
        expect(
          codigo(await intentarRaw(app, rol, `truncate ${t}`)),
          `${rol} ${t}`,
        ).toBe("42501");
      }
    }
  });

  it("compra_hallazgo: unico por (compra_id, version_n, regla); una regla distinta o otra version entran", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const INS =
      "insert into compra_hallazgo (compra_id, version_n, regla, sugerencia, lecturas, requiere_confirmacion) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)";
    const w = dbs.contapp_worker;
    const v = (n: number, regla: string) => [
      c.id,
      n,
      regla,
      JSON.stringify({ destino: "DNG" }),
      JSON.stringify({ biDg: "1000.00" }),
      true,
    ];
    expect(await intentar(w, { tenantId: X }, INS, v(1, "R-ISC"))).toEqual({
      ok: true,
      rowCount: 1,
    });
    await w.withTenant({ tenantId: X }, (tx) => tx.query(INS, v(1, "R-ISC")));
    expect(codigo(await intentar(w, { tenantId: X }, INS, v(1, "R-ISC")))).toBe(
      "23505",
    );
    expect(await intentar(w, { tenantId: X }, INS, v(1, "R-MIX"))).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(await intentar(w, { tenantId: X }, INS, v(2, "R-ISC"))).toEqual({
      ok: true,
      rowCount: 1,
    });
  });
});

// =================================================================================================
describe("0032 · compra_operacion: solo estado y deshecha_en son mutables", () => {
  beforeEach(requiereSiembra);

  it("privilegios: SELECT/INSERT al backend; UPDATE solo de (estado, deshecha_en); DELETE y TRUNCATE a nadie", async () => {
    expect(
      await privilegio("contapp_backend", "compra_operacion", "SELECT"),
    ).toBe(true);
    expect(
      await privilegio("contapp_backend", "compra_operacion", "INSERT"),
    ).toBe(true);
    for (const col of ["estado", "deshecha_en"])
      expect(
        await privilegioColumna(
          "contapp_backend",
          "compra_operacion",
          col,
          "UPDATE",
        ),
        col,
      ).toBe(true);
    for (const col of [
      "id",
      "tenant_id",
      "cliente_id",
      "periodo",
      "usuario_id",
      "tipo",
      "referencia_id",
      "creada_en",
    ]) {
      expect(
        await privilegioColumna(
          "contapp_backend",
          "compra_operacion",
          col,
          "UPDATE",
        ),
        col,
      ).toBe(false);
    }
    for (const rol of ROLES) {
      expect(
        await privilegio(rol, "compra_operacion", "DELETE"),
        `${rol} DELETE`,
      ).toBe(false);
      expect(
        await privilegio(rol, "compra_operacion", "TRUNCATE"),
        `${rol} TRUNCATE`,
      ).toBe(false);
    }
  });

  it("el backend pasa una operacion de vigente a deshecha y a caducada; no puede cambiar su dueno, su tipo ni borrarla", async () => {
    const id = await ec.operacion(X, cx, { usuarioId: ux, tipo: "editar" });
    const b = dbs.contapp_backend;
    await b.withTenant({ tenantId: X }, async (tx) => {
      expect(
        (
          await tx.query(
            "update compra_operacion set estado = 'deshecha', deshecha_en = now() where id = $1",
            [id],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await tx.query(
            "update compra_operacion set estado = 'caducada' where id = $1",
            [id],
          )
        ).rowCount,
      ).toBe(1);
    });
    for (const sql of [
      "update compra_operacion set usuario_id = gen_random_uuid() where id = $1",
      "update compra_operacion set tipo = 'otro' where id = $1",
      "update compra_operacion set periodo = '202601' where id = $1",
      "delete from compra_operacion where id = $1",
    ]) {
      expect((await intentar(b, { tenantId: X }, sql, [id])).ok, sql).toBe(
        false,
      );
    }
    expect(
      (
        await admin.query(
          "select estado, tipo from compra_operacion where id = $1",
          [id],
        )
      ).rows[0],
    ).toEqual({ estado: "caducada", tipo: "editar" });
  });
});

// =================================================================================================
describe("0033 · compra_periodo: estado con compare-and-set (D-9)", () => {
  beforeEach(requiereSiembra);

  it("privilegios: SELECT/INSERT y UPDATE de (estado, marcado_por, marcado_en) a los dos roles (012b marca generado desde el worker, y FOR SHARE exige UPDATE); sin DELETE ni TRUNCATE", async () => {
    for (const rol of ROLES) {
      expect(
        await privilegio(rol, "compra_periodo", "SELECT"),
        `${rol} SELECT`,
      ).toBe(true);
      expect(
        await privilegio(rol, "compra_periodo", "INSERT"),
        `${rol} INSERT`,
      ).toBe(true);
      for (const col of ["estado", "marcado_por", "marcado_en"])
        expect(
          await privilegioColumna(rol, "compra_periodo", col, "UPDATE"),
          `${rol} ${col}`,
        ).toBe(true);
      for (const col of ["tenant_id", "cliente_id", "periodo"])
        expect(
          await privilegioColumna(rol, "compra_periodo", col, "UPDATE"),
          `${rol} ${col}`,
        ).toBe(false);
      expect(
        await privilegio(rol, "compra_periodo", "DELETE"),
        `${rol} DELETE`,
      ).toBe(false);
      expect(
        await privilegio(rol, "compra_periodo", "TRUNCATE"),
        `${rol} TRUNCATE`,
      ).toBe(false);
    }
  });

  it("INSERT ... ON CONFLICT DO NOTHING crea la fila una sola vez y UPDATE ... WHERE estado = $esperado es el compare-and-set", async () => {
    const c = await ec.cliente(X);
    const b = dbs.contapp_backend;
    const crear = () =>
      b.withTenant({ tenantId: X }, (tx) =>
        tx.query(
          "insert into compra_periodo (cliente_id, periodo, estado) values ($1, $2, 'abierto') on conflict do nothing",
          [c.id, PERIODO],
        ),
      );
    expect((await crear()).rowCount).toBe(1);
    expect((await crear()).rowCount).toBe(0);
    const cas = (desde: string, hacia: string) =>
      b.withTenant({ tenantId: X }, async (tx) => {
        const r = await tx.query(
          "update compra_periodo set estado = $4, marcado_por = $5, marcado_en = now() where cliente_id = $1 and periodo = $2 and estado = $3",
          [c.id, PERIODO, desde, hacia, ux],
        );
        return r.rowCount;
      });
    expect(await cas("abierto", "revisado")).toBe(1);
    expect(
      await cas("abierto", "revisado"),
      "el estado esperado ya no es el vigente",
    ).toBe(0);
    expect(
      (
        await admin.query(
          "select estado, marcado_por from compra_periodo where cliente_id = $1",
          [c.id],
        )
      ).rows[0],
    ).toEqual({ estado: "revisado", marcado_por: ux });
  });

  it("no hay dos filas para el mismo (cliente, periodo) (23505)", async () => {
    const c = await ec.cliente(X);
    await ec.estadoPeriodo(X, c, PERIODO, "abierto");
    const b = dbs.contapp_backend;
    expect(
      codigo(
        await intentar(
          b,
          { tenantId: X },
          "insert into compra_periodo (cliente_id, periodo, estado) values ($1, $2, 'revisado')",
          [c.id, PERIODO],
        ),
      ),
    ).toBe("23505");
  });
});
