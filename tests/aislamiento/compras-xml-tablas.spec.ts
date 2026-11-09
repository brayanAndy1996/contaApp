// Spec 016 (T5, rojo): tablas de las migraciones 0035 (`documento_xml`, `documento_xml_obtencion`) y 0036 (`compra_evaluacion` y la
// nueva unica de `compra_hallazgo`) contra la BD real. Cubre D-4, D-5 y D-10 (columnas, RLS FORCE, grants, CHECK, FK compuestas,
// aislamiento por estudio) y el backfill de 0036 sobre una base temporal. Hasta T11 fallan por tabla inexistente. El contrato
// completo (tablas y funciones) esta en el encabezado de `compras-xml-soporte.ts`. No repite lo de `compras-tablas.spec.ts` (014).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { abrirPool, filasRaw, intentar, type ContappDb } from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  claveCompra,
  INSERTAR_VERSION,
  PERIODO,
  valoresVersion,
} from "./compras-soporte";
import { EscenarioXml, detalleXml, rutaDe } from "./compras-xml-soporte";

const ROLES = ["contapp_backend", "contapp_worker"] as const;
const TABLAS_NUEVAS = [
  "documento_xml",
  "documento_xml_obtencion",
  "compra_evaluacion",
] as const;
const ID = {
  rucEmisor: "20100070970",
  tipo: "01",
  serie: "F001",
  numero: "2056",
};

let admin: Pool;
let app: Pool;
let ec: EscenarioXml;
const dbs: Record<(typeof ROLES)[number], ContappDb> = {} as never;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let propX: string;
let propY: string;
let errSiembra: unknown;
const requiereSiembra = () => {
  if (errSiembra) throw errSiembra;
};

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  ec = new EscenarioXml(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  for (const r of ROLES) dbs[r] = crearDb(r, 4);
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
      `select column_name, data_type, numeric_precision as p, numeric_scale as s, is_nullable, column_default as defecto
         from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [tabla],
    )
  ).rows as {
    column_name: string;
    data_type: string;
    p: number | null;
    s: number | null;
    is_nullable: string;
    defecto: string | null;
  }[];
const privilegio = async (rol: string, tabla: string, priv: string) =>
  (
    await admin.query(
      "select has_table_privilege($1::name, $2::regclass, $3::text) as v",
      [rol, `public.${tabla}`, priv],
    )
  ).rows[0].v as boolean;
const algunaColumna = async (rol: string, tabla: string, priv: string) =>
  (
    await admin.query(
      "select has_any_column_privilege($1::name, $2::regclass, $3::text) as v",
      [rol, `public.${tabla}`, priv],
    )
  ).rows[0].v as boolean;
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
const unicas = async (tabla: string) =>
  (
    await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas, i.indisprimary as pk
         from pg_index i where i.indrelid = to_regclass($1) and i.indisunique`,
      [`public.${tabla}`],
    )
  ).rows as { columnas: string[]; pk: boolean }[];

/** Una compra sembrada (con su version 1) del estudio X. */
const compraX = (numero: string) =>
  ec.compra(X, cx, { propuestaId: propX, serie: "F001", numero });

// =================================================================================================
describe("0035 y 0036 · columnas y tipos (D-4, D-5, D-10)", () => {
  const ESPERADAS: Record<string, string[]> = {
    documento_xml: [
      "id",
      "tenant_id",
      "cliente_id",
      "ruc_emisor",
      "tipo",
      "serie",
      "numero",
      "n",
      "origen",
      "ruta",
      "sha256",
      "tamano",
      "detalle",
      "subido_por",
      "creada_en",
    ],
    documento_xml_obtencion: [
      "tenant_id",
      "cliente_id",
      "ruc_emisor",
      "tipo",
      "serie",
      "numero",
      "estado",
      "intentos",
      "actualizado_en",
    ],
    compra_evaluacion: [
      "id",
      "tenant_id",
      "compra_id",
      "version_n",
      "n",
      "documento_xml_id",
      "creada_en",
    ],
  };
  for (const [tabla, esperadas] of Object.entries(ESPERADAS)) {
    it(`${tabla}: tiene todas las columnas del plan`, async () => {
      const nombres = (await columnasDe(tabla)).map((c) => c.column_name);
      expect(
        nombres,
        `falta la tabla ${tabla} (migracion 0035/0036)`,
      ).not.toHaveLength(0);
      expect(nombres).toEqual(expect.arrayContaining(esperadas));
    });
  }

  it("ninguna columna de las tablas nuevas termina en _at (013 usa _en)", async () => {
    const r = await admin.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name = any($1::text[])`,
      [[...TABLAS_NUEVAS]],
    );
    expect(new Set(r.rows.map((x) => x.table_name)), "faltan tablas").toEqual(
      new Set(TABLAS_NUEVAS),
    );
    expect(r.rows.filter((x) => /_at$/.test(x.column_name))).toEqual([]);
  });

  it("documento_xml: sha256 bytea, detalle jsonb, n y tamano enteros NOT NULL, subido_por nulo", async () => {
    const c = Object.fromEntries(
      (await columnasDe("documento_xml")).map((x) => [x.column_name, x]),
    );
    expect(Object.keys(c), "falta documento_xml").not.toHaveLength(0);
    expect([c.sha256?.data_type, c.detalle?.data_type]).toEqual([
      "bytea",
      "jsonb",
    ]);
    expect([c.n?.data_type, c.tamano?.data_type]).toEqual([
      "integer",
      "integer",
    ]);
    for (const k of [
      "n",
      "tamano",
      "origen",
      "ruta",
      "sha256",
      "detalle",
      "ruc_emisor",
      "tipo",
      "serie",
      "numero",
    ])
      expect(c[k]?.is_nullable, k).toBe("NO");
    expect(c.subido_por?.is_nullable).toBe("YES");
  });

  it("compra_evaluacion: n y version_n enteros NOT NULL; documento_xml_id admite nulo (evaluacion sin XML)", async () => {
    const c = Object.fromEntries(
      (await columnasDe("compra_evaluacion")).map((x) => [x.column_name, x]),
    );
    expect(Object.keys(c), "falta compra_evaluacion").not.toHaveLength(0);
    expect([c.n?.data_type, c.version_n?.data_type]).toEqual([
      "integer",
      "integer",
    ]);
    expect([c.n?.is_nullable, c.version_n?.is_nullable]).toEqual(["NO", "NO"]);
    expect(c.documento_xml_id?.is_nullable).toBe("YES");
  });

  it("compra_hallazgo gana evaluacion_n entero NOT NULL y SIN default (el default 1 solo sirve al backfill)", async () => {
    const e = (await columnasDe("compra_hallazgo")).find(
      (x) => x.column_name === "evaluacion_n",
    );
    expect(e, "falta compra_hallazgo.evaluacion_n (0036)").toBeDefined();
    expect([e!.data_type, e!.is_nullable, e!.defecto]).toEqual([
      "integer",
      "NO",
      null,
    ]);
  });

  it("documento_xml_obtencion: clave primaria (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero)", async () => {
    const pk = (await unicas("documento_xml_obtencion")).filter((u) => u.pk);
    expect(
      pk.map((u) => u.columnas),
      "falta documento_xml_obtencion",
    ).toEqual([
      ["tenant_id", "cliente_id", "ruc_emisor", "tipo", "serie", "numero"],
    ]);
  });
});

// =================================================================================================
describe("0035 y 0036 · RLS ENABLE + FORCE y catalogo de 002 (CA-17)", () => {
  for (const tabla of TABLAS_NUEVAS) {
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
describe("0035 y 0036 · grants: solo insercion salvo el estado de obtencion (D-4, D-10)", () => {
  for (const tabla of [
    "documento_xml",
    "compra_evaluacion",
    "compra_hallazgo",
  ] as const) {
    it(`${tabla}: SELECT/INSERT a los dos roles; ni UPDATE (de ninguna columna) ni DELETE ni TRUNCATE`, async () => {
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
          await privilegio(rol, tabla, "UPDATE"),
          `${rol} UPDATE ${tabla}`,
        ).toBe(false);
        expect(
          await algunaColumna(rol, tabla, "UPDATE"),
          `${rol} UPDATE de alguna columna de ${tabla}`,
        ).toBe(false);
      }
    });
  }

  it("documento_xml_obtencion: SELECT, INSERT y UPDATE a los dos roles (backend y worker); sin DELETE ni TRUNCATE", async () => {
    for (const rol of ROLES) {
      expect(
        await privilegio(rol, "documento_xml_obtencion", "SELECT"),
        `${rol} SELECT`,
      ).toBe(true);
      expect(
        await privilegio(rol, "documento_xml_obtencion", "INSERT"),
        `${rol} INSERT`,
      ).toBe(true);
      expect(
        await algunaColumna(rol, "documento_xml_obtencion", "UPDATE"),
        `${rol} UPDATE`,
      ).toBe(true);
      expect(
        await privilegio(rol, "documento_xml_obtencion", "DELETE"),
        `${rol} DELETE`,
      ).toBe(false);
      expect(
        await privilegio(rol, "documento_xml_obtencion", "TRUNCATE"),
        `${rol} TRUNCATE`,
      ).toBe(false);
    }
  });

  it("el UPDATE y el DELETE de documento_xml y de compra_evaluacion se rechazan con 42501 aunque la fila sea propia", async () => {
    requiereSiembra();
    const c = await compraX("5001");
    const xmlId = await ec.xml(X, cx, { ...ID, numero: "5001" });
    const evId = await ec.evaluacion(X, c.id, 1, 1, xmlId);
    for (const rol of ROLES) {
      for (const [sql, valores] of [
        ["update documento_xml set tamano = 1 where id = $1", [xmlId]],
        ["delete from documento_xml where id = $1", [xmlId]],
        [
          "update compra_evaluacion set documento_xml_id = null where id = $1",
          [evId],
        ],
        ["delete from compra_evaluacion where id = $1", [evId]],
      ] as const)
        expect(
          codigo(await intentar(dbs[rol], { tenantId: X }, sql, [...valores])),
          `${rol}: ${sql}`,
        ).toBe("42501");
    }
  });

  it("documento_xml_obtencion: se actualiza el estado y no se borra (DELETE 42501)", async () => {
    requiereSiembra();
    await ec.obtencion(X, cx, { ...ID, numero: "5002" }, "pendiente");
    for (const rol of ROLES) {
      const u = await intentar(
        dbs[rol],
        { tenantId: X },
        `update documento_xml_obtencion set estado = 'no_encontrado', intentos = intentos + 1, actualizado_en = now()
          where cliente_id = $1 and numero = '5002'`,
        [cx.id],
      );
      expect(u, `${rol} UPDATE del estado`).toEqual({ ok: true, rowCount: 1 });
      expect(
        codigo(
          await intentar(
            dbs[rol],
            { tenantId: X },
            "delete from documento_xml_obtencion where cliente_id = $1 and numero = '5002'",
            [cx.id],
          ),
        ),
        `${rol} DELETE`,
      ).toBe("42501");
    }
  });

  it("documento_xml_obtencion: el UPDATE no puede mover la fila a otro estudio (RLS con WITH CHECK)", async () => {
    requiereSiembra();
    await ec.obtencion(X, cx, { ...ID, numero: "5003" }, "pendiente");
    const r = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      "update documento_xml_obtencion set tenant_id = $2 where cliente_id = $1 and numero = '5003'",
      [cx.id, Y],
    );
    expect(r.ok).toBe(false);
    expect(["42501", "23503"]).toContain(codigo(r));
  });
});

// =================================================================================================
describe("0035 y 0036 · aislamiento por estudio (CA-17)", () => {
  beforeEach(requiereSiembra);

  it("el otro estudio y la consulta sin contexto ven 0 filas de las tres tablas; el propio estudio ve las suyas", async () => {
    const c = await compraX("5101");
    const xmlId = await ec.xml(X, cx, { ...ID, numero: "5101" });
    await ec.evaluacion(X, c.id, 1, 1, xmlId);
    await ec.obtencion(X, cx, { ...ID, numero: "5102" }, "transitorio");
    for (const rol of ROLES) {
      for (const tabla of TABLAS_NUEVAS) {
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

  it("documento_xml: no se inserta con el tenant_id de otro estudio (42501) ni para un cliente ajeno (23503)", async () => {
    const e = {
      ruta: rutaDe(X, cx.id),
      sha: randomBytes(32),
    };
    const conTenantAjeno = await intentar(
      dbs.contapp_worker,
      { tenantId: X },
      `insert into documento_xml (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle)
       values ($1, $2, '20100070970', '01', 'F001', '1', 1, 'real', $3, $4, 10, '{}')`,
      [Y, cy.id, e.ruta, e.sha],
    );
    expect(codigo(conTenantAjeno)).toBe("42501");
    const clienteAjeno = await intentar(
      dbs.contapp_worker,
      { tenantId: X },
      `insert into documento_xml (cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle)
       values ($1, '20100070970', '01', 'F001', '1', 1, 'real', $2, $3, 10, '{}')`,
      [cy.id, e.ruta, e.sha],
    );
    expect(codigo(clienteAjeno), "FK compuesta (tenant_id, cliente_id)").toBe(
      "23503",
    );
  });

  it("documento_xml_obtencion: no se escribe el estado de un cliente ajeno (23503) ni con otro tenant_id (42501)", async () => {
    const ajeno = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      `insert into documento_xml_obtencion (cliente_id, ruc_emisor, tipo, serie, numero, estado)
       values ($1, '20100070970', '01', 'F001', '1', 'pendiente')`,
      [cy.id],
    );
    expect(codigo(ajeno)).toBe("23503");
    const otroTenant = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      `insert into documento_xml_obtencion (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, estado)
       values ($1, $2, '20100070970', '01', 'F001', '1', 'pendiente')`,
      [Y, cy.id],
    );
    expect(codigo(otroTenant)).toBe("42501");
  });
});

// =================================================================================================
describe("0035 y 0036 · FK compuestas (D-4, D-5)", () => {
  const exige = async (
    tabla: string,
    destino: string,
    columnas: string[],
    destinos: string[],
  ) => {
    const f = (await fks(tabla)).find(
      (x) =>
        x.destino === destino && columnas.every((c) => x.columnas.includes(c)),
    );
    expect(
      f,
      `falta la FK de ${tabla}(${columnas.join(",")}) a ${destino}`,
    ).toBeDefined();
    expect([f!.columnas, f!.destinos]).toEqual([columnas, destinos]);
  };

  it("documento_xml y documento_xml_obtencion -> cliente (tenant_id, cliente_id)", async () => {
    await exige(
      "documento_xml",
      "cliente",
      ["tenant_id", "cliente_id"],
      ["tenant_id", "id"],
    );
    await exige(
      "documento_xml_obtencion",
      "cliente",
      ["tenant_id", "cliente_id"],
      ["tenant_id", "id"],
    );
  });

  it("compra_evaluacion -> compra_version (tenant, compra, version) y -> documento_xml (tenant, id)", async () => {
    await exige(
      "compra_evaluacion",
      "compra_version",
      ["tenant_id", "compra_id", "version_n"],
      ["tenant_id", "compra_id", "n"],
    );
    await exige(
      "compra_evaluacion",
      "documento_xml",
      ["tenant_id", "documento_xml_id"],
      ["tenant_id", "id"],
    );
  });

  it("compra_hallazgo -> compra_evaluacion (tenant, compra, version, evaluacion_n)", async () => {
    await exige(
      "compra_hallazgo",
      "compra_evaluacion",
      ["tenant_id", "compra_id", "version_n", "evaluacion_n"],
      ["tenant_id", "compra_id", "version_n", "n"],
    );
  });

  it("una evaluacion no puede colgar de una version inexistente ni de una compra de otro estudio (23503)", async () => {
    requiereSiembra();
    const c = await compraX("5201");
    const inexistente = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      "insert into compra_evaluacion (compra_id, version_n, n) values ($1, 7, 1)",
      [c.id],
    );
    expect(codigo(inexistente)).toBe("23503");
    const ajena = await ec.compra(Y, cy, { propuestaId: propY });
    const deOtro = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      "insert into compra_evaluacion (compra_id, version_n, n) values ($1, 1, 1)",
      [ajena.id],
    );
    expect(["23503", "42501"]).toContain(codigo(deOtro));
  });

  it("una evaluacion no puede apuntar al XML de otro estudio (23503) y un XML con evaluaciones no se puede borrar", async () => {
    requiereSiembra();
    const c = await compraX("5202");
    const xmlY = await ec.xml(Y, cy, ID);
    const r = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      "insert into compra_evaluacion (compra_id, version_n, n, documento_xml_id) values ($1, 1, 1, $2)",
      [c.id, xmlY],
    );
    expect(codigo(r), "FK compuesta (tenant_id, documento_xml_id)").toBe(
      "23503",
    );
    const xmlX = await ec.xml(X, cx, { ...ID, numero: "5202" });
    await ec.evaluacion(X, c.id, 1, 1, xmlX);
    const del = await admin
      .query("delete from documento_xml where id = $1", [xmlX])
      .then(
        () => "ok",
        (e: { code?: string }) => e.code ?? "sin codigo",
      );
    expect(del).toBe("23503");
  });

  it("un hallazgo no puede colgar de una evaluacion inexistente (23503)", async () => {
    requiereSiembra();
    const c = await compraX("5203");
    await ec.evaluacion(X, c.id, 1, 1);
    const r = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      `insert into compra_hallazgo (compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas, requiere_confirmacion)
       values ($1, 1, 2, 'R-X', '{}', '{}', false)`,
      [c.id],
    );
    expect(codigo(r)).toBe("23503");
  });
});

// =================================================================================================
describe("0035 · documento_xml: CHECK de origen, subido_por y tamano; unica por n (D-4)", () => {
  beforeEach(requiereSiembra);

  const insertar = (
    rol: (typeof ROLES)[number],
    o: {
      origen?: string;
      subidoPor?: string | null;
      tamano?: number;
      n?: number;
      numero?: string;
    },
  ) =>
    intentar(
      dbs[rol],
      { tenantId: X },
      `insert into documento_xml (cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle, subido_por)
       values ($1, '20100070970', '01', 'F001', $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        cx.id,
        o.numero ?? "6001",
        o.n ?? 1,
        o.origen ?? "real",
        rutaDe(X, cx.id),
        randomBytes(32),
        o.tamano ?? 100,
        JSON.stringify(detalleXml()),
        o.subidoPor === undefined ? null : o.subidoPor,
      ],
    );

  it("origen solo admite simulado, real o subido (23514 con otro valor)", async () => {
    expect(await insertar("contapp_worker", { origen: "simulado" })).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(await insertar("contapp_worker", { origen: "real" })).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(
      await insertar("contapp_backend", { origen: "subido", subidoPor: ux }),
    ).toEqual({ ok: true, rowCount: 1 });
    for (const malo of ["manual", "SUBIDO", "", "sire"])
      expect(
        codigo(await insertar("contapp_worker", { origen: malo })),
        `origen ${JSON.stringify(malo)}`,
      ).toBe("23514");
  });

  it("subido_por es NOT NULL si y solo si el origen es subido (23514 en los dos sentidos)", async () => {
    expect(
      codigo(
        await insertar("contapp_backend", {
          origen: "subido",
          subidoPor: null,
        }),
      ),
    ).toBe("23514");
    expect(
      codigo(
        await insertar("contapp_backend", { origen: "real", subidoPor: ux }),
      ),
    ).toBe("23514");
    expect(
      codigo(
        await insertar("contapp_backend", {
          origen: "simulado",
          subidoPor: ux,
        }),
      ),
    ).toBe("23514");
  });

  it("tamano admite hasta 1 MiB exacto; 1 MiB + 1 da 23514", async () => {
    expect(await insertar("contapp_backend", { tamano: 1_048_576 })).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(
      codigo(await insertar("contapp_backend", { tamano: 1_048_577 })),
    ).toBe("23514");
  });

  it("(cliente, emisor, tipo, serie, numero, n) es unico (23505); otro n del mismo comprobante convive", async () => {
    await ec.xml(X, cx, { ...ID, numero: "6002" }, { n: 1 });
    expect(
      codigo(await insertar("contapp_backend", { numero: "6002", n: 1 })),
    ).toBe("23505");
    expect(await insertar("contapp_backend", { numero: "6002", n: 2 })).toEqual(
      { ok: true, rowCount: 1 },
    );
  });

  it("la unica incluye al cliente: el mismo comprobante en otro cliente del estudio no choca", async () => {
    const otro = await ec.cliente(X);
    await ec.xml(X, cx, { ...ID, numero: "6003" }, { n: 1 });
    await ec.xml(X, otro, { ...ID, numero: "6003" }, { n: 1 });
    expect(
      (
        await admin.query(
          "select count(*)::int as n from documento_xml where numero = '6003' and tenant_id = $1",
          [X],
        )
      ).rows[0].n,
    ).toBe(2);
  });
});

describe("0035 · documento_xml_obtencion: estado cerrado y una fila por comprobante (D-4)", () => {
  beforeEach(requiereSiembra);

  const insertar = (estado: string, numero: string) =>
    intentar(
      dbs.contapp_worker,
      { tenantId: X },
      `insert into documento_xml_obtencion (cliente_id, ruc_emisor, tipo, serie, numero, estado)
       values ($1, '20100070970', '01', 'F001', $2, $3)`,
      [cx.id, numero, estado],
    );

  it("estado solo admite pendiente, no_encontrado, credencial o transitorio (23514 con otro valor)", async () => {
    for (const [k, bueno] of [
      "pendiente",
      "no_encontrado",
      "credencial",
      "transitorio",
    ].entries())
      expect(await insertar(bueno, `70${k}`), bueno).toEqual({
        ok: true,
        rowCount: 1,
      });
    for (const malo of ["listo", "error", "", "PENDIENTE"])
      expect(
        codigo(await insertar(malo, "7000")),
        `estado ${JSON.stringify(malo)}`,
      ).toBe("23514");
  });

  it("intentos nace en 0 y la PK impide dos filas del mismo comprobante (23505)", async () => {
    await ec.obtencion(X, cx, { ...ID, numero: "7101" }, "pendiente");
    const f = (
      await admin.query(
        "select intentos, actualizado_en from documento_xml_obtencion where cliente_id = $1 and numero = '7101'",
        [cx.id],
      )
    ).rows[0];
    expect(f.intentos).toBe(0);
    expect(f.actualizado_en).toBeInstanceOf(Date);
    expect(codigo(await insertar("transitorio", "7101"))).toBe("23505");
  });
});

// =================================================================================================
describe("0036 · compra_evaluacion y la unica de compra_hallazgo (D-5)", () => {
  beforeEach(requiereSiembra);

  it("compra_evaluacion: (compra, version, n) es unica (23505); otra n de la misma version convive", async () => {
    const c = await compraX("8001");
    await ec.evaluacion(X, c.id, 1, 1);
    const r = (n: number) =>
      intentar(
        dbs.contapp_backend,
        { tenantId: X },
        "insert into compra_evaluacion (compra_id, version_n, n) values ($1, 1, $2)",
        [c.id, n],
      );
    expect(codigo(await r(1))).toBe("23505");
    expect(await r(2)).toEqual({ ok: true, rowCount: 1 });
  });

  it("compra_evaluacion: el XML puede ser nulo (evaluacion sin XML) o uno propio", async () => {
    const c = await compraX("8002");
    const xmlId = await ec.xml(X, cx, { ...ID, numero: "8002" });
    expect(
      await intentar(
        dbs.contapp_worker,
        { tenantId: X },
        "insert into compra_evaluacion (compra_id, version_n, n, documento_xml_id) values ($1, 1, 1, null)",
        [c.id],
      ),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(
      await intentar(
        dbs.contapp_worker,
        { tenantId: X },
        "insert into compra_evaluacion (compra_id, version_n, n, documento_xml_id) values ($1, 1, 2, $2)",
        [c.id, xmlId],
      ),
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("compra_hallazgo: la misma regla en otra evaluacion de la version convive; en la misma evaluacion da 23505", async () => {
    const c = await compraX("8003");
    await ec.hallazgo(X, c.id, 1, "R-MIX", 1);
    await ec.evaluacion(X, c.id, 1, 2);
    const h = (evaluacion: number) =>
      intentar(
        dbs.contapp_backend,
        { tenantId: X },
        `insert into compra_hallazgo (compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas, requiere_confirmacion)
         values ($1, 1, $2, 'R-MIX', '{}', '{}', false)`,
        [c.id, evaluacion],
      );
    expect(codigo(await h(1))).toBe("23505");
    expect(
      await h(2),
      "la re-evaluacion de la misma version ya no choca (nota [016] de 014 DU-22)",
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("compra_hallazgo: evaluacion_n es obligatorio (sin default, 23502)", async () => {
    const c = await compraX("8004");
    await ec.evaluacion(X, c.id, 1, 1);
    const r = await intentar(
      dbs.contapp_backend,
      { tenantId: X },
      `insert into compra_hallazgo (compra_id, version_n, regla, sugerencia, lecturas, requiere_confirmacion)
       values ($1, 1, 'R-X', '{}', '{}', false)`,
      [c.id],
    );
    expect(codigo(r)).toBe("23502");
  });

  it("una version nueva (insertada con el rol de la app) admite su evaluacion 1 aunque la anterior tenga varias", async () => {
    const c = await compraX("8005");
    await ec.evaluacion(X, c.id, 1, 1);
    await ec.evaluacion(X, c.id, 1, 2);
    await dbs.contapp_backend.withTenant({ tenantId: X }, async (tx) => {
      await tx.query(INSERTAR_VERSION, valoresVersion(c.id, 2));
      await tx.query(
        "insert into compra_evaluacion (compra_id, version_n, n) values ($1, 2, 1)",
        [c.id],
      );
    });
    expect(
      (
        await admin.query(
          "select version_n, n from compra_evaluacion where compra_id = $1 order by version_n, n",
          [c.id],
        )
      ).rows,
    ).toEqual([
      { version_n: 1, n: 1 },
      { version_n: 1, n: 2 },
      { version_n: 2, n: 1 },
    ]);
  });
});

// =================================================================================================
describe("0036 · backfill: los hallazgos sembrados antes de migrar quedan en la evaluacion 1 (D-5, D-10)", () => {
  // Base temporal: se aplican las migraciones ANTERIORES a la de `compra_evaluacion`, se siembran compras, versiones y hallazgos
  // con el esquema viejo y despues se aplican la migracion de la evaluacion numerada y las que le sigan. Asi el backfill corre con
  // datos reales (riesgo de la 0036 en el plan). Las migraciones se localizan por nombre, no por numero, para sobrevivir a la
  // renumeracion frente a 012b.
  const CARPETA = resolve(__dirname, "../../packages/db/migrations/");
  const entradas = (): string[] =>
    (
      JSON.parse(readFileSync(`${CARPETA}/meta/_journal.json`, "utf8")) as {
        entries: { tag: string }[];
      }
    ).entries.map((e) => e.tag);
  const aplicar = async (c: Client, tags: string[]) => {
    for (const tag of tags)
      for (const s of readFileSync(`${CARPETA}/${tag}.sql`, "utf8").split(
        "--> statement-breakpoint",
      ))
        if (s.trim() !== "") await c.query(s);
  };

  it("cada version existente recibe una evaluacion n = 1 sin XML y cada hallazgo existente queda con evaluacion_n = 1", async () => {
    const tags = entradas();
    const i = tags.findIndex((t) => /compra_evaluacion/.test(t));
    expect(
      i,
      "falta la migracion de compra_evaluacion (0036) en el diario de drizzle",
    ).toBeGreaterThanOrEqual(0);
    const base = process.env.MIGRATIONS_DATABASE_URL;
    if (!base) throw new Error("falta MIGRATIONS_DATABASE_URL");
    const nombre = `contapp_t5_${randomBytes(5).toString("hex")}`;
    const raiz = new Client({ connectionString: base });
    await raiz.connect();
    let c: Client | undefined;
    try {
      await raiz.query(`create database ${nombre}`);
      const u = new URL(base);
      u.pathname = `/${nombre}`;
      c = new Client({ connectionString: u.toString() });
      await c.connect();
      await aplicar(c, tags.slice(0, i));

      // Siembra con el esquema anterior. `replica` salta triggers y FK (no hay estudio ni cliente reales en la base temporal);
      // los CHECK y los NOT NULL siguen vigentes.
      const T = "11111111-1111-4111-8111-111111111111";
      const CL = "22222222-2222-4222-8222-222222222222";
      await c.query("SET session_replication_role = replica");
      const compra = async (
        serie: string,
        numero: string,
        versiones: number,
      ) => {
        const r = await c!.query(
          `insert into compra (tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
                               fecha, moneda, origen, version_vigente)
           values ($1, $2, $3, null, $4, '01', $5, $6, '6', '20100070970', '2026-10-05', 'PEN', 'agregada', $7) returning id`,
          [
            T,
            CL,
            PERIODO,
            claveCompra("01", serie, numero, "6", "20100070970"),
            serie,
            numero,
            versiones,
          ],
        );
        const id = r.rows[0].id as string;
        for (let n = 1; n <= versiones; n++)
          await c!.query(
            `insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc,
                                         icbper, otros_tributos, total, excluida, motivo, clasificada, accion)
             values ($1, $2, $3, 100, 18, 0, 0, 0, 0, 0, 0, 0, 0, 118, false, null, false, $4)`,
            [T, id, n, n === 1 ? "agregada" : "editar"],
          );
        return id;
      };
      const hallazgo = async (
        compraId: string,
        versionN: number,
        regla: string,
      ) => {
        const r = await c!.query(
          `insert into compra_hallazgo (tenant_id, compra_id, version_n, regla, sugerencia, lecturas, requiere_confirmacion)
           values ($1, $2, $3, $4, '{}', '{}', false) returning id`,
          [T, compraId, versionN, regla],
        );
        return r.rows[0].id as string;
      };
      const a = await compra("F001", "1", 2);
      const b = await compra("F001", "2", 1);
      const d = await compra("F001", "3", 3);
      const idsHallazgo = [
        await hallazgo(a, 1, "R-ISC"),
        await hallazgo(a, 1, "R-MIX"),
        await hallazgo(a, 2, "R-MIX"),
        await hallazgo(d, 1, "R-NEW"),
      ];
      await c.query("SET session_replication_role = origin");

      await aplicar(c, tags.slice(i));

      const ev = (
        await c.query(
          "select compra_id, version_n, n, documento_xml_id from compra_evaluacion order by compra_id, version_n",
        )
      ).rows;
      expect(
        ev,
        "una evaluacion n = 1 por cada compra_version (2 + 1 + 3)",
      ).toHaveLength(6);
      expect(ev.every((e) => e.n === 1 && e.documento_xml_id === null)).toBe(
        true,
      );
      expect(new Set(ev.map((e) => `${e.compra_id}:${e.version_n}`))).toEqual(
        new Set(
          [a, b, d].flatMap((id, k) =>
            Array.from({ length: [2, 1, 3][k]! }, (_, j) => `${id}:${j + 1}`),
          ),
        ),
      );
      const h = (
        await c.query(
          "select id, evaluacion_n from compra_hallazgo order by id",
        )
      ).rows;
      expect(
        h.map((x) => x.id).sort(),
        "los hallazgos existentes se conservan",
      ).toEqual([...idsHallazgo].sort());
      expect(h.every((x) => x.evaluacion_n === 1)).toBe(true);

      // El esquema nuevo ya rige sobre lo migrado: sin default, una evaluacion 2 convive y la unica incluye la evaluacion.
      const col = (
        await c.query(
          "select is_nullable, column_default from information_schema.columns where table_name = 'compra_hallazgo' and column_name = 'evaluacion_n'",
        )
      ).rows[0];
      expect([col.is_nullable, col.column_default]).toEqual(["NO", null]);
      await c.query(
        "insert into compra_evaluacion (tenant_id, compra_id, version_n, n) values ($1, $2, 1, 2)",
        [T, a],
      );
      await c.query(
        `insert into compra_hallazgo (tenant_id, compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas, requiere_confirmacion)
         values ($1, $2, 1, 2, 'R-MIX', '{}', '{}', false)`,
        [T, a],
      );
      await expect(
        c.query(
          `insert into compra_hallazgo (tenant_id, compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas, requiere_confirmacion)
           values ($1, $2, 1, 1, 'R-MIX', '{}', '{}', false)`,
          [T, a],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await c?.end().catch(() => undefined);
      await raiz
        .query(`drop database if exists ${nombre} with (force)`)
        .catch(() => undefined);
      await raiz.end().catch(() => undefined);
    }
  }, 60_000);
});
