// Spec 026 (T3, rojo): tablas de la migracion 0065 (`prorrata_obtencion`, `declaracion_mensual`, `prorrata_mes_manual`,
// `prorrata_usada_manual` y el CHECK de acciones de auditoria) contra la BD real. Cubre D-4, D-6, CA-8: columnas y tipos, RLS FORCE,
// grants (el backend lee; el worker nada; nadie escribe directo), UPDATE y DELETE 42501 por trigger, FK compuestas (fila de otro
// cliente u otro estudio imposible), CHECK de montos, porcentajes, accion y coherencia de montos NULL, unicas por orden y por version,
// y aislamiento entre estudios y entre clientes. Hasta T10 fallan por tabla inexistente. Modelo: `reglas-importacion-tablas.spec.ts`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { enRevertida } from "./auditoria-soporte";
import {
  abrirPool,
  filasRaw,
  intentar,
  intentarRaw,
  type ContappDb,
} from "./soporte";
import { codigo, crearDb } from "./trabajos-soporte";
import {
  ACCIONES_PRORRATA,
  EscenarioProrrata,
  ROLES_APP,
  TABLAS_PRORRATA,
  ventana,
  type ClientePrueba,
} from "./prorrata-soporte";

let admin: Pool;
let app: Pool;
let ep: EscenarioProrrata;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let uy: string;
let obtX: string;
let obtY: string;
let declX: string;
let declY: string;
let manX: string;
let manY: string;
let usaX: string;
let usaY: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  ep = new EscenarioProrrata(admin);
  X = (await ep.estudio()).id;
  Y = (await ep.estudio()).id;
  cx = await ep.cliente(X);
  cx2 = await ep.cliente(X);
  cy = await ep.cliente(Y);
  ux = await ep.usuarioDe(X);
  uy = await ep.usuarioDe(Y);
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
  // Estado base de lectura: una obtencion con su declaracion, un manual y una prorrata ingresada en cada estudio.
  obtX = await ep.obtencion(X, cx);
  obtY = await ep.obtencion(Y, cy);
  declX = await ep.declaracion(X, cx, { obtencionId: obtX });
  declY = await ep.declaracion(Y, cy, { obtencionId: obtY });
  manX = await ep.manual(X, cx, { periodo: "202609" });
  manY = await ep.manual(Y, cy, { periodo: "202609" });
  usaX = await ep.usada(X, cx);
  usaY = await ep.usada(Y, cy);
});
afterAll(async () => {
  await ep?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close(), ep?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await app?.end();
  await admin?.end();
});

const columnasDe = async (tabla: string) =>
  (
    await admin.query(
      `select column_name, data_type, udt_name, character_maximum_length as largo, numeric_precision as precision,
              numeric_scale as escala, is_nullable, column_default as defecto
         from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [tabla],
    )
  ).rows as {
    column_name: string;
    data_type: string;
    udt_name: string;
    largo: number | null;
    precision: number | null;
    escala: number | null;
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
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as columnas
         from pg_constraint c where c.conrelid = to_regclass($1) and c.contype = 'f'`,
      [`public.${tabla}`],
    )
  ).rows as { destino: string; columnas: string[] }[];
const indices = async (tabla: string) =>
  (
    await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas,
              i.indisunique as unico, i.indisprimary as pk, pg_get_expr(i.indpred, i.indrelid) as predicado
         from pg_index i where i.indrelid = to_regclass($1)`,
      [`public.${tabla}`],
    )
  ).rows as {
    columnas: string[];
    unico: boolean;
    pk: boolean;
    predicado: string | null;
  }[];

// =================================================================================================
describe("0065 · columnas y tipos (plan: Contratos · BD)", () => {
  const ESPERADAS: Record<string, string[]> = {
    prorrata_obtencion: [
      "id",
      "tenant_id",
      "cliente_id",
      "periodo_hasta",
      "trabajo_id",
      "periodos_leidos",
      "periodos_sin_declaracion",
      "nuevas",
      "obtenida_en",
    ],
    declaracion_mensual: [
      "id",
      "tenant_id",
      "cliente_id",
      "periodo",
      "numero_orden",
      "fecha_presentacion",
      "tipo",
      "ventas_gravadas_base",
      "ventas_gravadas_igv",
      "exportaciones",
      "no_gravadas",
      "igv_adq_dg",
      "igv_adq_dgng",
      "prorrata_usada",
      "obtencion_id",
    ],
    prorrata_mes_manual: [
      "id",
      "tenant_id",
      "cliente_id",
      "periodo",
      "version",
      "accion",
      "gravadas",
      "exportaciones",
      "no_gravadas",
      "motivo",
      "autor",
      "creado_en",
    ],
    prorrata_usada_manual: [
      "id",
      "tenant_id",
      "cliente_id",
      "periodo",
      "version",
      "porcentaje",
      "autor",
      "creado_en",
    ],
  };
  for (const [tabla, esperadas] of Object.entries(ESPERADAS)) {
    it(`${tabla}: tiene todas las columnas del plan y ninguna termina en _at (013 usa _en)`, async () => {
      const nombres = (await columnasDe(tabla)).map((c) => c.column_name);
      expect(
        nombres,
        `falta la tabla ${tabla} (migracion 0065)`,
      ).not.toHaveLength(0);
      expect(nombres).toEqual(expect.arrayContaining(esperadas));
      expect(nombres.filter((n) => /_at$/.test(n))).toEqual([]);
    });
  }

  it("claves: id con uuid_v7 por defecto y tenant_id con app.tenant_id por defecto en las cuatro tablas", async () => {
    for (const t of TABLAS_PRORRATA) {
      const c = Object.fromEntries(
        (await columnasDe(t)).map((x) => [x.column_name, x]),
      );
      expect(c.id, `falta ${t}`).toBeDefined();
      expect(c.id!.defecto).toMatch(/uuid_v7\(\)/);
      expect(c.tenant_id!.defecto).toMatch(/app\.tenant_id/);
    }
  });

  it("periodos: char(6) NOT NULL en las tres tablas por periodo; periodo_hasta char(6) y los dos arreglos char(6)[] en la obtencion", async () => {
    for (const t of [
      "declaracion_mensual",
      "prorrata_mes_manual",
      "prorrata_usada_manual",
    ]) {
      const c = Object.fromEntries(
        (await columnasDe(t)).map((x) => [x.column_name, x]),
      );
      expect(
        [c.periodo?.data_type, c.periodo?.largo, c.periodo?.is_nullable],
        t,
      ).toEqual(["character", 6, "NO"]);
    }
    const o = Object.fromEntries(
      (await columnasDe("prorrata_obtencion")).map((x) => [x.column_name, x]),
    );
    expect(
      [
        o.periodo_hasta?.data_type,
        o.periodo_hasta?.largo,
        o.periodo_hasta?.is_nullable,
      ],
      "falta prorrata_obtencion",
    ).toEqual(["character", 6, "NO"]);
    for (const k of ["periodos_leidos", "periodos_sin_declaracion"])
      expect([o[k]?.udt_name, o[k]?.is_nullable], k).toEqual(["_bpchar", "NO"]);
    expect([o.nuevas?.data_type, o.nuevas?.is_nullable]).toEqual([
      "integer",
      "NO",
    ]);
    expect(o.trabajo_id?.is_nullable).toBe("YES");
  });

  it("montos NUMERIC(14,2) NOT NULL en la declaracion; prorrata_usada NUMERIC(5,2) nulo; numero_orden NUMERIC(15,0); tipo y fecha NOT NULL", async () => {
    const c = Object.fromEntries(
      (await columnasDe("declaracion_mensual")).map((x) => [x.column_name, x]),
    );
    expect(Object.keys(c), "falta declaracion_mensual").not.toHaveLength(0);
    for (const k of [
      "ventas_gravadas_base",
      "ventas_gravadas_igv",
      "exportaciones",
      "no_gravadas",
      "igv_adq_dg",
      "igv_adq_dgng",
    ])
      expect(
        [c[k]?.data_type, c[k]?.precision, c[k]?.escala, c[k]?.is_nullable],
        k,
      ).toEqual(["numeric", 14, 2, "NO"]);
    expect([
      c.prorrata_usada?.data_type,
      c.prorrata_usada?.precision,
      c.prorrata_usada?.escala,
      c.prorrata_usada?.is_nullable,
    ]).toEqual(["numeric", 5, 2, "YES"]);
    expect([
      c.numero_orden?.data_type,
      c.numero_orden?.precision,
      c.numero_orden?.escala,
      c.numero_orden?.is_nullable,
    ]).toEqual(["numeric", 15, 0, "NO"]);
    for (const k of [
      "tipo",
      "fecha_presentacion",
      "obtencion_id",
      "cliente_id",
    ])
      expect(c[k]?.is_nullable, k).toBe("NO");
  });

  it("prorrata_mes_manual: montos NUMERIC(14,2) nulos (los fija el CHECK de coherencia), version entera, motivo y autor NOT NULL", async () => {
    const c = Object.fromEntries(
      (await columnasDe("prorrata_mes_manual")).map((x) => [x.column_name, x]),
    );
    expect(Object.keys(c), "falta prorrata_mes_manual").not.toHaveLength(0);
    for (const k of ["gravadas", "exportaciones", "no_gravadas"])
      expect(
        [c[k]?.data_type, c[k]?.precision, c[k]?.escala, c[k]?.is_nullable],
        k,
      ).toEqual(["numeric", 14, 2, "YES"]);
    expect([c.version?.data_type, c.version?.is_nullable]).toEqual([
      "integer",
      "NO",
    ]);
    for (const k of ["accion", "motivo", "autor", "creado_en"])
      expect(c[k]?.is_nullable, k).toBe("NO");
  });

  it("prorrata_usada_manual: porcentaje NUMERIC(5,2) nulo, version entera, autor NOT NULL", async () => {
    const c = Object.fromEntries(
      (await columnasDe("prorrata_usada_manual")).map((x) => [
        x.column_name,
        x,
      ]),
    );
    expect(Object.keys(c), "falta prorrata_usada_manual").not.toHaveLength(0);
    expect([
      c.porcentaje?.data_type,
      c.porcentaje?.precision,
      c.porcentaje?.escala,
      c.porcentaje?.is_nullable,
    ]).toEqual(["numeric", 5, 2, "YES"]);
    expect([c.version?.data_type, c.version?.is_nullable]).toEqual([
      "integer",
      "NO",
    ]);
    expect(c.autor?.is_nullable).toBe("NO");
  });
});

// =================================================================================================
describe("0065 · FK compuestas y unicas (D-4)", () => {
  const FKS: [string, string, string[]][] = [
    ["prorrata_obtencion", "cliente", ["tenant_id", "cliente_id"]],
    ["declaracion_mensual", "cliente", ["tenant_id", "cliente_id"]],
    [
      "declaracion_mensual",
      "prorrata_obtencion",
      ["tenant_id", "cliente_id", "obtencion_id"],
    ],
    ["prorrata_mes_manual", "cliente", ["tenant_id", "cliente_id"]],
    ["prorrata_mes_manual", "usuario", ["autor"]],
    ["prorrata_usada_manual", "cliente", ["tenant_id", "cliente_id"]],
    ["prorrata_usada_manual", "usuario", ["autor"]],
  ];
  for (const [tabla, destino, columnas] of FKS) {
    it(`${tabla} -> ${destino} por (${columnas.join(", ")})`, async () => {
      const f = await fks(tabla);
      expect(f, `falta la tabla ${tabla}`).not.toHaveLength(0);
      expect(
        f.some(
          (x) =>
            x.destino.endsWith(destino) &&
            x.columnas.join() === columnas.join(),
        ),
        `FK ${tabla} -> ${destino}: ${JSON.stringify(f)}`,
      ).toBe(true);
    });
  }

  const UNICAS: [string, string[]][] = [
    [
      "declaracion_mensual",
      ["tenant_id", "cliente_id", "periodo", "numero_orden"],
    ],
    ["prorrata_mes_manual", ["tenant_id", "cliente_id", "periodo", "version"]],
    [
      "prorrata_usada_manual",
      ["tenant_id", "cliente_id", "periodo", "version"],
    ],
  ];
  for (const [tabla, columnas] of UNICAS) {
    it(`${tabla}: unica por (${columnas.join(", ")})`, async () => {
      const i = await indices(tabla);
      expect(i, `falta la tabla ${tabla}`).not.toHaveLength(0);
      expect(
        i.some(
          (x) => x.unico && !x.pk && x.columnas.join() === columnas.join(),
        ),
        JSON.stringify(i),
      ).toBe(true);
    });
  }
});

// =================================================================================================
describe("0065 · RLS ENABLE + FORCE, dueno y tenant_isolation (CA-8)", () => {
  for (const tabla of TABLAS_PRORRATA) {
    it(`${tabla}: RLS habilitada y forzada con tenant_isolation FOR ALL sobre app.tenant_id, dueno contapp_migrator, tenant_id uuid NOT NULL`, async () => {
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
      const a = await admin.query(
        `select a.attnotnull, t.typname from pg_class c
           join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
           join pg_type t on t.oid = a.atttypid where c.oid = to_regclass($1)`,
        [`public.${tabla}`],
      );
      expect(a.rows).toEqual([{ attnotnull: true, typname: "uuid" }]);
    });
  }
});

// =================================================================================================
describe("0065 · grants: el backend lee, el worker nada, nadie escribe directo; solo insercion (D-4)", () => {
  it("backend: SELECT en las cuatro; ningun rol de la app tiene INSERT, UPDATE, DELETE ni TRUNCATE (ni por columna)", async () => {
    for (const t of TABLAS_PRORRATA) {
      expect(
        await privilegio("contapp_backend", t, "SELECT"),
        `backend SELECT ${t}`,
      ).toBe(true);
      for (const rol of ROLES_APP) {
        for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
          expect(await privilegio(rol, t, p), `${rol} ${p} ${t}`).toBe(false);
        for (const p of ["INSERT", "UPDATE"])
          expect(await algunaColumna(rol, t, p), `${rol} col ${p} ${t}`).toBe(
            false,
          );
      }
    }
  });

  it("worker, app, platform, enumerador, auth y registrador no tienen ningun privilegio sobre las cuatro tablas", async () => {
    for (const t of TABLAS_PRORRATA)
      for (const rol of ROLES_APP.filter((r) => r !== "contapp_backend")) {
        expect(await privilegio(rol, t, "SELECT"), `${rol} SELECT ${t}`).toBe(
          false,
        );
        expect(
          await algunaColumna(rol, t, "SELECT"),
          `${rol} col SELECT ${t}`,
        ).toBe(false);
      }
  });

  it("escritura directa: el INSERT, UPDATE y DELETE del backend y del worker dan 42501 en las cuatro tablas", async () => {
    const sqls = [
      `insert into prorrata_obtencion (cliente_id, periodo_hasta, periodos_leidos, periodos_sin_declaracion, nuevas)
         values ('${cx2.id}', '202610', array['202610']::char(6)[], '{}'::char(6)[], 0)`,
      "update prorrata_obtencion set nuevas = 9",
      "delete from prorrata_obtencion",
      `insert into declaracion_mensual (cliente_id, periodo, numero_orden, fecha_presentacion, tipo, ventas_gravadas_base,
         ventas_gravadas_igv, exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng, obtencion_id)
         values ('${cx.id}', '202610', 77, '2026-11-05', 'original', 1, 1, 0, 0, 0, 0, '${obtX}')`,
      "update declaracion_mensual set tipo = 'rectificatoria'",
      "delete from declaracion_mensual",
      `insert into prorrata_mes_manual (cliente_id, periodo, version, accion, gravadas, exportaciones, no_gravadas, motivo, autor)
         values ('${cx.id}', '202608', 1, 'guardado', 1, 0, 0, 'x', '${ux}')`,
      "update prorrata_mes_manual set motivo = 'otro'",
      "delete from prorrata_mes_manual",
      `insert into prorrata_usada_manual (cliente_id, periodo, version, porcentaje, autor)
         values ('${cx.id}', '202608', 1, 10, '${ux}')`,
      "update prorrata_usada_manual set porcentaje = 20",
      "delete from prorrata_usada_manual",
    ];
    for (const [db, rol] of [
      [backend, "backend"],
      [worker, "worker"],
    ] as const) {
      for (const s of sqls)
        expect(
          codigo(await intentar(db, { tenantId: X, userId: ux }, s)),
          `${rol}: ${s.slice(0, 50)}`,
        ).toBe("42501");
    }
  });

  it("el worker no puede leer ninguna de las cuatro tablas (42501)", async () => {
    for (const t of TABLAS_PRORRATA)
      expect(
        codigo(await intentar(worker, { tenantId: X }, `select * from ${t}`)),
        t,
      ).toBe("42501");
  });

  it("UPDATE y DELETE: hay un trigger que rechaza cada uno y el superusuario si puede (037: borrado del cliente)", async () => {
    for (const t of TABLAS_PRORRATA) {
      const r = await admin.query(
        `select count(*) filter (where (tgtype & 8) = 8)::int as borra, count(*) filter (where (tgtype & 16) = 16)::int as actualiza
           from pg_trigger where tgrelid = to_regclass($1) and not tgisinternal`,
        [`public.${t}`],
      );
      expect(r.rows[0].borra, `${t}: trigger BEFORE DELETE`).toBeGreaterThan(0);
      expect(
        r.rows[0].actualiza,
        `${t}: trigger BEFORE UPDATE`,
      ).toBeGreaterThan(0);
    }
    const sembrada = await ep.obtencion(X, cx2, { periodoHasta: "202601" });
    const act = await enRevertida(admin, async (c) => {
      await c.query("update prorrata_obtencion set nuevas = 3 where id = $1", [
        sembrada,
      ]);
    });
    expect(act.ok, "superusuario UPDATE").toBe(true);
    expect(
      (
        await admin.query("delete from prorrata_obtencion where id = $1", [
          sembrada,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it("el dueno (contapp_migrator, no superusuario) tampoco actualiza: el trigger solo exime al superusuario", async () => {
    for (const [t, sql] of [
      [
        "declaracion_mensual",
        "update declaracion_mensual set tipo = 'rectificatoria' where id = $1",
      ],
      [
        "prorrata_mes_manual",
        "update prorrata_mes_manual set motivo = 'otro' where id = $1",
      ],
      [
        "prorrata_usada_manual",
        "update prorrata_usada_manual set porcentaje = 1 where id = $1",
      ],
    ] as const) {
      const id = {
        declaracion_mensual: declX,
        prorrata_mes_manual: manX,
        prorrata_usada_manual: usaX,
      }[t];
      const r = await enRevertida(admin, async (c) => {
        await c.query("select set_config('app.tenant_id', $1, true)", [X]);
        await c.query("SET LOCAL ROLE contapp_migrator");
        await c.query(sql, [id]);
      });
      expect(r.ok ? "ok" : r.code, t).toBe("42501");
    }
  });
});

// =================================================================================================
// Inserciones con el superusuario (pasa por CHECK, FK, unicas y triggers) en una transaccion que siempre se revierte.
type Fila = Record<string, unknown>;
const BASES: Record<string, () => Fila> = {
  prorrata_obtencion: () => ({
    tenant_id: X,
    cliente_id: cx.id,
    periodo_hasta: "202610",
    periodos_leidos: ventana("202610"),
    periodos_sin_declaracion: [],
    nuevas: 0,
  }),
  declaracion_mensual: () => ({
    tenant_id: X,
    cliente_id: cx.id,
    periodo: "202610",
    numero_orden: "5001",
    fecha_presentacion: "2026-11-05",
    tipo: "original",
    ventas_gravadas_base: "100000.00",
    ventas_gravadas_igv: "18000.00",
    exportaciones: "0.00",
    no_gravadas: "5000.00",
    igv_adq_dg: "9000.00",
    igv_adq_dgng: "1800.00",
    prorrata_usada: null,
    obtencion_id: obtX,
  }),
  prorrata_mes_manual: () => ({
    tenant_id: X,
    cliente_id: cx.id,
    periodo: "202608",
    version: 1,
    accion: "guardado",
    gravadas: "1000.00",
    exportaciones: "0.00",
    no_gravadas: "200.00",
    motivo: "Motivo de prueba",
    autor: ux,
  }),
  prorrata_usada_manual: () => ({
    tenant_id: X,
    cliente_id: cx.id,
    periodo: "202608",
    version: 1,
    porcentaje: "50.00",
    autor: ux,
  }),
};
const insertar = (tabla: string, o: Fila = {}) =>
  enRevertida(admin, async (c) => {
    const f = { ...BASES[tabla]!(), ...o };
    const k = Object.keys(f);
    const marcas = k.map((n, i) => {
      if (n === "periodos_leidos" || n === "periodos_sin_declaracion")
        return `$${i + 1}::char(6)[]`;
      if (n === "numero_orden") return `$${i + 1}::numeric`;
      return `$${i + 1}`;
    });
    await c.query(
      `insert into ${tabla} (${k.join(", ")}) values (${marcas.join(", ")})`,
      Object.values(f),
    );
  });
const cod = (r: Awaited<ReturnType<typeof insertar>>) => (r.ok ? "ok" : r.code);

describe("0065 · CHECK de prorrata_obtencion (periodo, cantidad de periodos, conteo)", () => {
  it("una obtencion valida entra (la prueba no es vacua)", async () => {
    expect(cod(await insertar("prorrata_obtencion"))).toBe("ok");
    expect(
      cod(
        await insertar("prorrata_obtencion", {
          periodos_leidos: ["202610"],
          periodos_sin_declaracion: ["202610"],
        }),
      ),
    ).toBe("ok");
  });

  it("periodo_hasta AAAAMM con mes 01 a 12; otro formato da 23514", async () => {
    for (const p of ["202601", "202612"])
      expect(
        cod(await insertar("prorrata_obtencion", { periodo_hasta: p })),
        p,
      ).toBe("ok");
    for (const p of ["202600", "202613", "20261", "abcdef"])
      expect(
        cod(await insertar("prorrata_obtencion", { periodo_hasta: p })),
        p,
      ).toBe("23514");
  });

  it("periodos leidos: no mas de 12 (13 da 23514); nulo da 23502", async () => {
    expect(
      cod(
        await insertar("prorrata_obtencion", {
          periodos_leidos: ventana("202610"),
        }),
      ),
      "12",
    ).toBe("ok");
    const trece = [...ventana("202610"), "202510"];
    expect(
      cod(await insertar("prorrata_obtencion", { periodos_leidos: trece })),
      "13",
    ).toBe("23514");
    expect(
      cod(await insertar("prorrata_obtencion", { periodos_leidos: null })),
      "nulo",
    ).toBe("23502");
  });

  it("nuevas: 0 o mas; negativo da 23514", async () => {
    expect(cod(await insertar("prorrata_obtencion", { nuevas: 12 }))).toBe(
      "ok",
    );
    expect(cod(await insertar("prorrata_obtencion", { nuevas: -1 }))).toBe(
      "23514",
    );
  });
});

describe("0065 · CHECK de declaracion_mensual (orden, tipo, rangos, prorrata usada) y unica por orden", () => {
  it("una declaracion valida entra (la prueba no es vacua), con y sin prorrata usada", async () => {
    expect(cod(await insertar("declaracion_mensual"))).toBe("ok");
    expect(
      cod(await insertar("declaracion_mensual", { prorrata_usada: "87.34" })),
    ).toBe("ok");
  });

  it("numero_orden: de 1 a 15 digitos; 0 y negativo dan 23514; 16 digitos dan 22003", async () => {
    for (const n of ["1", "999999999999999"])
      expect(
        cod(await insertar("declaracion_mensual", { numero_orden: n })),
        n,
      ).toBe("ok");
    for (const n of ["0", "-5"])
      expect(
        cod(await insertar("declaracion_mensual", { numero_orden: n })),
        n,
      ).toBe("23514");
    expect(
      cod(
        await insertar("declaracion_mensual", {
          numero_orden: "1000000000000000",
        }),
      ),
      "16 digitos",
    ).toBe("22003");
  });

  it("tipo: original o rectificatoria; otro valor da 23514", async () => {
    for (const t of ["original", "rectificatoria"])
      expect(
        cod(
          await insertar("declaracion_mensual", {
            tipo: t,
            numero_orden: "5002",
          }),
        ),
        t,
      ).toBe("ok");
    for (const t of ["sustitutoria", "ORIGINAL", ""])
      expect(cod(await insertar("declaracion_mensual", { tipo: t })), t).toBe(
        "23514",
      );
  });

  it("montos: dentro de NUMERIC(14,2) entran (12 digitos), fuera dan 22003 y nulo da 23502", async () => {
    for (const k of [
      "ventas_gravadas_base",
      "ventas_gravadas_igv",
      "exportaciones",
      "no_gravadas",
      "igv_adq_dg",
      "igv_adq_dgng",
    ]) {
      expect(
        cod(await insertar("declaracion_mensual", { [k]: "999999999999.99" })),
        `${k} maximo`,
      ).toBe("ok");
      expect(
        cod(await insertar("declaracion_mensual", { [k]: "1000000000000.00" })),
        `${k} fuera`,
      ).toBe("22003");
      expect(
        cod(await insertar("declaracion_mensual", { [k]: null })),
        `${k} nulo`,
      ).toBe("23502");
    }
  });

  it("prorrata_usada: de 0.00 a 100.00 (nula permitida); -0.01 y 100.01 dan 23514", async () => {
    for (const p of ["0.00", "100.00", "33.33", null])
      expect(
        cod(await insertar("declaracion_mensual", { prorrata_usada: p })),
        String(p),
      ).toBe("ok");
    for (const p of ["-0.01", "100.01", "150.00"])
      expect(
        cod(await insertar("declaracion_mensual", { prorrata_usada: p })),
        p,
      ).toBe("23514");
  });

  it("unica (estudio, cliente, periodo, numero_orden): la misma presentacion da 23505; otro orden, otro periodo u otro cliente no chocan", async () => {
    const dup = { periodo: "202610", numero_orden: "1001" };
    expect(
      cod(await insertar("declaracion_mensual", { ...dup, cliente_id: cx.id })),
      "ya sembrada",
    ).toBe("23505");
    expect(
      cod(
        await insertar("declaracion_mensual", { ...dup, numero_orden: "1002" }),
      ),
      "otro orden",
    ).toBe("ok");
    expect(
      cod(await insertar("declaracion_mensual", { ...dup, periodo: "202609" })),
      "otro periodo",
    ).toBe("ok");
    expect(
      cod(
        await insertar("declaracion_mensual", {
          ...dup,
          cliente_id: cx2.id,
          obtencion_id: await ep.obtencion(X, cx2),
        }),
      ),
      "otro cliente",
    ).toBe("ok");
  });
});

describe("0065 · CHECK de prorrata_mes_manual (version, accion, coherencia de montos, motivo) y unica por version", () => {
  it("un manual valido entra (la prueba no es vacua), en cero tambien; eliminado con montos nulos entra", async () => {
    expect(cod(await insertar("prorrata_mes_manual"))).toBe("ok");
    expect(
      cod(
        await insertar("prorrata_mes_manual", {
          gravadas: "0.00",
          exportaciones: "0.00",
          no_gravadas: "0.00",
        }),
      ),
    ).toBe("ok");
    expect(
      cod(
        await insertar("prorrata_mes_manual", {
          version: 2,
          accion: "eliminado",
          gravadas: null,
          exportaciones: null,
          no_gravadas: null,
        }),
      ),
    ).toBe("ok");
  });

  it("version: 1 o mas; 0 y negativa dan 23514", async () => {
    for (const v of [0, -1])
      expect(
        cod(await insertar("prorrata_mes_manual", { version: v })),
        String(v),
      ).toBe("23514");
  });

  it("accion: guardado o eliminado; otro valor da 23514", async () => {
    for (const a of ["borrado", "GUARDADO", ""])
      expect(cod(await insertar("prorrata_mes_manual", { accion: a })), a).toBe(
        "23514",
      );
  });

  it("coherencia: guardado exige los tres montos; eliminado los exige nulos (23514 si no)", async () => {
    for (const k of ["gravadas", "exportaciones", "no_gravadas"])
      expect(
        cod(await insertar("prorrata_mes_manual", { [k]: null })),
        `guardado sin ${k}`,
      ).toBe("23514");
    for (const k of ["gravadas", "exportaciones", "no_gravadas"]) {
      const nulos = {
        gravadas: null,
        exportaciones: null,
        no_gravadas: null,
        accion: "eliminado",
        version: 2,
      };
      expect(
        cod(await insertar("prorrata_mes_manual", { ...nulos, [k]: "1.00" })),
        `eliminado con ${k}`,
      ).toBe("23514");
    }
  });

  it("montos: dentro de NUMERIC(14,2) entran, fuera dan 22003", async () => {
    for (const k of ["gravadas", "exportaciones", "no_gravadas"]) {
      expect(
        cod(await insertar("prorrata_mes_manual", { [k]: "999999999999.99" })),
        `${k} maximo`,
      ).toBe("ok");
      expect(
        cod(await insertar("prorrata_mes_manual", { [k]: "1000000000000.00" })),
        `${k} fuera`,
      ).toBe("22003");
    }
  });

  it("motivo: 1 a 500 caracteres sin controles ni marcas bidi; vacio, 501, control o bidi dan 23514; nulo da 23502", async () => {
    expect(
      cod(await insertar("prorrata_mes_manual", { motivo: "x" })),
      "1",
    ).toBe("ok");
    expect(
      cod(await insertar("prorrata_mes_manual", { motivo: "ñ".repeat(500) })),
      "500",
    ).toBe("ok");
    expect(
      cod(await insertar("prorrata_mes_manual", { motivo: "" })),
      "vacio",
    ).toBe("23514");
    expect(
      cod(await insertar("prorrata_mes_manual", { motivo: "x".repeat(501) })),
      "501",
    ).toBe("23514");
    for (const [n, m] of [
      ["bell", "uno\u0007dos"],
      ["salto", "uno\ndos"],
      ["nul-c1", "uno\u0085dos"],
      ["RLO", "uno‮dos"],
      ["isolate", "uno⁦dos"],
      ["ALM", "uno؜dos"],
    ] as const)
      expect(cod(await insertar("prorrata_mes_manual", { motivo: m })), n).toBe(
        "23514",
      );
    expect(
      cod(await insertar("prorrata_mes_manual", { motivo: null })),
      "nulo",
    ).toBe("23502");
  });

  it("unica (estudio, cliente, periodo, version): repetir la version da 23505; otra version, periodo o cliente no chocan", async () => {
    expect(
      cod(
        await insertar("prorrata_mes_manual", {
          periodo: "202609",
          version: 1,
        }),
      ),
      "ya sembrada",
    ).toBe("23505");
    expect(
      cod(
        await insertar("prorrata_mes_manual", {
          periodo: "202609",
          version: 2,
        }),
      ),
      "otra version",
    ).toBe("ok");
    expect(
      cod(
        await insertar("prorrata_mes_manual", {
          periodo: "202607",
          version: 1,
        }),
      ),
      "otro periodo",
    ).toBe("ok");
    expect(
      cod(
        await insertar("prorrata_mes_manual", {
          periodo: "202609",
          cliente_id: cx2.id,
        }),
      ),
      "otro cliente",
    ).toBe("ok");
  });
});

describe("0065 · CHECK de prorrata_usada_manual (version, porcentaje) y unica por version", () => {
  it("una prorrata ingresada valida entra (la prueba no es vacua); porcentaje nulo tambien (deja el mes sin prorrata usada)", async () => {
    expect(cod(await insertar("prorrata_usada_manual"))).toBe("ok");
    expect(
      cod(await insertar("prorrata_usada_manual", { porcentaje: null })),
    ).toBe("ok");
  });

  it("version: 1 o mas; 0 y negativa dan 23514", async () => {
    for (const v of [0, -1])
      expect(
        cod(await insertar("prorrata_usada_manual", { version: v })),
        String(v),
      ).toBe("23514");
  });

  it("porcentaje: de 0.00 a 100.00; -0.01 y 100.01 dan 23514", async () => {
    for (const p of ["0.00", "100.00", "87.34"])
      expect(
        cod(await insertar("prorrata_usada_manual", { porcentaje: p })),
        p,
      ).toBe("ok");
    for (const p of ["-0.01", "100.01"])
      expect(
        cod(await insertar("prorrata_usada_manual", { porcentaje: p })),
        p,
      ).toBe("23514");
  });

  it("unica (estudio, cliente, periodo, version): repetir da 23505; otra version o cliente no chocan", async () => {
    const base = { periodo: "202610", version: 1 };
    expect(
      cod(await insertar("prorrata_usada_manual", base)),
      "ya sembrada",
    ).toBe("23505");
    expect(
      cod(await insertar("prorrata_usada_manual", { ...base, version: 2 })),
      "otra version",
    ).toBe("ok");
    expect(
      cod(
        await insertar("prorrata_usada_manual", {
          ...base,
          cliente_id: cx2.id,
        }),
      ),
      "otro cliente",
    ).toBe("ok");
  });
});

// =================================================================================================
describe("0065 · FK compuestas: una fila de otro cliente u otro estudio es imposible (23503)", () => {
  it("declaracion_mensual: cliente de otro estudio, cliente inexistente y obtencion de otro cliente u otro estudio", async () => {
    expect(
      cod(
        await insertar("declaracion_mensual", {
          cliente_id: cy.id,
          obtencion_id: obtY,
          numero_orden: "9001",
        }),
      ),
      "cliente de Y con tenant X",
    ).toBe("23503");
    expect(
      cod(
        await insertar("declaracion_mensual", {
          cliente_id: "00000000-0000-4000-8000-000000000001",
          numero_orden: "9002",
        }),
      ),
      "cliente inexistente",
    ).toBe("23503");
    expect(
      cod(
        await insertar("declaracion_mensual", {
          cliente_id: cx2.id,
          obtencion_id: obtX,
          numero_orden: "9003",
        }),
      ),
      "obtencion del cliente cx",
    ).toBe("23503");
    expect(
      cod(
        await insertar("declaracion_mensual", {
          obtencion_id: obtY,
          numero_orden: "9004",
        }),
      ),
      "obtencion de Y",
    ).toBe("23503");
  });

  it("prorrata_obtencion, prorrata_mes_manual y prorrata_usada_manual: cliente de otro estudio da 23503", async () => {
    for (const t of [
      "prorrata_obtencion",
      "prorrata_mes_manual",
      "prorrata_usada_manual",
    ])
      expect(cod(await insertar(t, { cliente_id: cy.id })), t).toBe("23503");
  });

  it("autor inexistente da 23503 en los dos manuales", async () => {
    for (const t of ["prorrata_mes_manual", "prorrata_usada_manual"])
      expect(
        cod(
          await insertar(t, { autor: "00000000-0000-4000-8000-000000000002" }),
        ),
        t,
      ).toBe("23503");
  });
});

// =================================================================================================
describe("0065 · aislamiento entre estudios y entre clientes (CA-8)", () => {
  const FILAS: [string, () => string, () => string][] = [
    ["prorrata_obtencion", () => obtX, () => obtY],
    ["declaracion_mensual", () => declX, () => declY],
    ["prorrata_mes_manual", () => manX, () => manY],
    ["prorrata_usada_manual", () => usaX, () => usaY],
  ];

  it("el backend de cada estudio ve solo las filas de su estudio y no las del otro, ni por id", async () => {
    for (const [tabla, propia, ajena] of FILAS) {
      const r = await backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
        tx.query(`select id from ${tabla}`),
      );
      expect(
        r.rows.map((f) => f.id),
        `${tabla}: tabla vacia o sin RLS`,
      ).toContain(propia());
      expect(
        r.rows.map((f) => f.id),
        tabla,
      ).not.toContain(ajena());
      const porId = await backend.withTenant(
        { tenantId: X, userId: ux },
        (tx) => tx.query(`select 1 from ${tabla} where id = $1`, [ajena()]),
      );
      expect(porId.rowCount, `${tabla}: por id ajeno`).toBe(0);
    }
    const y = await backend.withTenant({ tenantId: Y, userId: uy }, (tx) =>
      tx.query("select id from declaracion_mensual"),
    );
    expect(y.rows.map((f) => f.id)).toEqual([declY]);
  });

  it("sin withTenant el backend ve 0 filas y el worker no tiene permiso (42501)", async () => {
    for (const t of TABLAS_PRORRATA) {
      expect(
        await filasRaw(app, "contapp_backend", `select 1 from ${t}`),
        `backend sin contexto: ${t}`,
      ).toEqual([]);
      const w = await intentarRaw(app, "contapp_worker", `select 1 from ${t}`);
      expect(w.ok ? "ok" : w.code, `worker sin contexto: ${t}`).toBe("42501");
    }
  });

  it("las filas del cliente A no aparecen al pedir por el cliente B del mismo estudio", async () => {
    const sinFilas = await ep.cliente(X);
    for (const t of TABLAS_PRORRATA) {
      const propias = await backend.withTenant(
        { tenantId: X, userId: ux },
        (tx) => tx.query(`select 1 from ${t} where cliente_id = $1`, [cx.id]),
      );
      expect(
        propias.rowCount,
        `${t}: las del cliente sembrado`,
      ).toBeGreaterThan(0);
      const ajenas = await backend.withTenant(
        { tenantId: X, userId: ux },
        (tx) =>
          tx.query(`select 1 from ${t} where cliente_id = $1`, [sinFilas.id]),
      );
      expect(ajenas.rowCount, t).toBe(0);
    }
  });
});

// =================================================================================================
describe("0065 · CHECK de acciones de auditoria (D-6)", () => {
  it("auditoria_accion_valida admite las cuatro acciones de la prorrata y sigue rechazando las ajenas (23514)", async () => {
    const ins = (accion: string) =>
      enRevertida(admin, async (c) => {
        await c.query(
          `insert into auditoria (tenant_id, actor_tipo, usuario_id, accion, cliente_id, entidad, entidad_id, datos)
           values ($1, 'usuario', $2, $3, $4, 'prorrata', $5, '{}'::jsonb)`,
          [X, ux, accion, cx.id, declX],
        );
      });
    for (const a of [...ACCIONES_PRORRATA, "regla.creada"])
      expect((await ins(a)).ok, a).toBe(true);
    for (const a of [
      "prorrata.calculada",
      "prorrata.declaraciones",
      "prorrata.mes_manual",
    ]) {
      const mala = await ins(a);
      expect(mala.ok ? "ok" : mala.code, a).toBe("23514");
    }
  });
});
