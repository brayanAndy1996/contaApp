// Spec 025 (T3, rojo): tablas de la migracion 0061 (`regla_importacion`, `regla_candidata`, `regla_aprendida.origen`, CHECK de codigos y
// de acciones) contra la BD real. Cubre D-1, D-2, D-4, D-7, D-11 y CA-7: columnas, RLS FORCE, grants (el backend lee; el worker lee solo
// la importacion; nadie escribe directo), DELETE 42501, FK compuestas, unicas, CHECK de coherencia y de umbral, razon social limpia y
// aislamiento entre estudios y entre clientes. Hasta T10 fallan por tabla o columna inexistente. Modelo: `reglas-tablas.spec.ts` (021).
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
  EscenarioImportacion,
  MOTIVOS_TRABAJO,
  ROLES_APP,
  TABLAS_IMPORTACION,
  periodosHasta,
  type ClientePrueba,
} from "./reglas-importacion-soporte";

let admin: Pool;
let app: Pool;
let ei: EscenarioImportacion;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let uy: string;
let impX: string;
let impY: string;
let candX: string;
let candY: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  ei = new EscenarioImportacion(admin);
  X = (await ei.estudio()).id;
  Y = (await ei.estudio()).id;
  cx = await ei.cliente(X);
  cx2 = await ei.cliente(X);
  cy = await ei.cliente(Y);
  ux = await ei.usuarioDe(X);
  uy = await ei.usuarioDe(Y);
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
  // Estado base de lectura: una importacion completada con una candidata en cada estudio.
  impX = await ei.importacion(X, cx);
  impY = await ei.importacion(Y, cy);
  candX = await ei.candidata(X, cx, impX, { docNumero: "20999000001" });
  candY = await ei.candidata(Y, cy, impY, { docNumero: "20999000001" });
});
afterAll(async () => {
  await ei?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close(), ei?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await app?.end();
  await admin?.end();
});

const columnasDe = async (tabla: string) =>
  (
    await admin.query(
      `select column_name, data_type, udt_name, character_maximum_length as largo, is_nullable, column_default as defecto
         from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [tabla],
    )
  ).rows as {
    column_name: string;
    data_type: string;
    udt_name: string;
    largo: number | null;
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
  ).rows as { columnas: string[]; unico: boolean; pk: boolean; predicado: string | null }[];

// =================================================================================================
describe("0061 · columnas y tipos (plan: Contratos · BD)", () => {
  const ESPERADAS: Record<string, string[]> = {
    regla_importacion: [
      "id",
      "tenant_id",
      "cliente_id",
      "estado",
      "periodos",
      "periodo_hasta",
      "trabajo_id",
      "solicitada_por",
      "solicitada_en",
      "terminada_en",
      "periodos_leidos",
      "periodos_sin_datos",
      "candidatas",
      "sin_criterio",
      "motivo",
    ],
    regla_candidata: [
      "id",
      "tenant_id",
      "cliente_id",
      "importacion_id",
      "doc_tipo",
      "doc_numero",
      "razon_social",
      "destino_propuesto",
      "n_dg",
      "n_dgng",
      "n_dng",
      "n_mixto",
      "n_total",
      "periodos_con_proveedor",
      "estado",
      "destino_elegido",
      "regla_id",
      "resuelta_por",
      "resuelta_en",
    ],
  };
  for (const [tabla, esperadas] of Object.entries(ESPERADAS)) {
    it(`${tabla}: tiene todas las columnas del plan y ninguna termina en _at (013 usa _en)`, async () => {
      const nombres = (await columnasDe(tabla)).map((c) => c.column_name);
      expect(nombres, `falta la tabla ${tabla} (migracion 0061)`).not.toHaveLength(0);
      expect(nombres).toEqual(expect.arrayContaining(esperadas));
      expect(nombres.filter((n) => /_at$/.test(n))).toEqual([]);
    });
  }

  it("regla_importacion: periodos char(6)[] y periodo_hasta char(6) NOT NULL; estado, cliente y solicitante NOT NULL; trabajo, terminada y motivo nulos", async () => {
    const c = Object.fromEntries(
      (await columnasDe("regla_importacion")).map((x) => [x.column_name, x]),
    );
    expect(Object.keys(c), "falta regla_importacion").not.toHaveLength(0);
    expect([c.periodos?.udt_name, c.periodos?.is_nullable]).toEqual(["_bpchar", "NO"]);
    expect([c.periodo_hasta?.data_type, c.periodo_hasta?.largo, c.periodo_hasta?.is_nullable]).toEqual([
      "character",
      6,
      "NO",
    ]);
    for (const k of ["estado", "cliente_id", "solicitada_por", "solicitada_en"])
      expect(c[k]?.is_nullable, k).toBe("NO");
    for (const k of ["trabajo_id", "terminada_en", "motivo"])
      expect(c[k]?.is_nullable, k).toBe("YES");
  });

  it("regla_candidata: conteos enteros NOT NULL; razon social, destino propuesto, elegido, regla y resuelta_* nulos", async () => {
    const c = Object.fromEntries(
      (await columnasDe("regla_candidata")).map((x) => [x.column_name, x]),
    );
    expect(Object.keys(c), "falta regla_candidata").not.toHaveLength(0);
    for (const k of ["n_dg", "n_dgng", "n_dng", "n_mixto", "n_total", "periodos_con_proveedor"])
      expect([c[k]?.data_type, c[k]?.is_nullable], k).toEqual(["integer", "NO"]);
    for (const k of ["doc_tipo", "doc_numero", "estado", "importacion_id", "cliente_id"])
      expect(c[k]?.is_nullable, k).toBe("NO");
    for (const k of [
      "razon_social",
      "destino_propuesto",
      "destino_elegido",
      "regla_id",
      "resuelta_por",
      "resuelta_en",
    ])
      expect(c[k]?.is_nullable, k).toBe("YES");
  });

  it("claves: id con uuid_v7 por defecto y tenant_id con app.tenant_id por defecto en las dos tablas", async () => {
    for (const t of TABLAS_IMPORTACION) {
      const c = Object.fromEntries((await columnasDe(t)).map((x) => [x.column_name, x]));
      expect(c.id, `falta ${t}`).toBeDefined();
      expect(c.id!.defecto).toMatch(/uuid_v7\(\)/);
      expect(c.tenant_id!.defecto).toMatch(/app\.tenant_id/);
    }
  });

  it("regla_aprendida.origen: text NOT NULL con defecto 'contador'", async () => {
    const o = (await columnasDe("regla_aprendida")).find((c) => c.column_name === "origen");
    expect(o, "falta regla_aprendida.origen (migracion 0061)").toBeDefined();
    expect([o!.data_type, o!.is_nullable, o!.defecto]).toEqual([
      "text",
      "NO",
      "'contador'::text",
    ]);
  });
});

// =================================================================================================
describe("0061 · FK compuestas, unicas e indice (D-4)", () => {
  const FKS: [string, string, string[]][] = [
    ["regla_importacion", "cliente", ["tenant_id", "cliente_id"]],
    ["regla_candidata", "regla_importacion", ["tenant_id", "cliente_id", "importacion_id"]],
    ["regla_candidata", "regla_aprendida", ["tenant_id", "regla_id"]],
  ];
  for (const [tabla, destino, columnas] of FKS) {
    it(`${tabla} -> ${destino} por (${columnas.join(", ")})`, async () => {
      const f = await fks(tabla);
      expect(f, `falta la tabla ${tabla}`).not.toHaveLength(0);
      expect(
        f.some((x) => x.destino.endsWith(destino) && x.columnas.join() === columnas.join()),
        `FK ${tabla} -> ${destino}: ${JSON.stringify(f)}`,
      ).toBe(true);
    });
  }

  it("regla_importacion: unica parcial (tenant_id, cliente_id) WHERE estado = 'en_curso'", async () => {
    const u = (await indices("regla_importacion")).find(
      (x) => x.unico && !x.pk && x.columnas.join() === "tenant_id,cliente_id",
    );
    expect(u, "falta la unica parcial de importaciones en curso").toBeDefined();
    expect(u!.predicado).toMatch(/en_curso/);
  });

  it("regla_candidata: unica (tenant_id, importacion_id, doc_tipo, doc_numero) e indice (tenant_id, cliente_id, estado, doc_tipo, doc_numero)", async () => {
    const i = await indices("regla_candidata");
    expect(i.some((x) => x.unico && x.columnas.join() === "tenant_id,importacion_id,doc_tipo,doc_numero")).toBe(true);
    expect(
      i.some((x) => x.columnas.join() === "tenant_id,cliente_id,estado,doc_tipo,doc_numero"),
      JSON.stringify(i),
    ).toBe(true);
  });
});

// =================================================================================================
describe("0061 · RLS ENABLE + FORCE, dueno y catalogo de 002 (CA-7)", () => {
  for (const tabla of TABLAS_IMPORTACION) {
    it(`${tabla}: RLS habilitada y forzada con tenant_isolation FOR ALL sobre app.tenant_id, dueno contapp_migrator, tenant_id uuid NOT NULL`, async () => {
      const t = await admin.query(
        `select c.relrowsecurity, c.relforcerowsecurity, o.rolname as dueno
           from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass($1)`,
        [`public.${tabla}`],
      );
      expect(t.rows, `falta la tabla ${tabla}`).toHaveLength(1);
      expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true, dueno: "contapp_migrator" });
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
describe("0061 · grants: el backend lee, el worker lee solo la importacion, nadie escribe directo (D-2)", () => {
  it("regla_importacion: SELECT a backend y worker; ningun rol de la app tiene INSERT, UPDATE, DELETE ni TRUNCATE (ni por columna)", async () => {
    expect(await privilegio("contapp_backend", "regla_importacion", "SELECT"), "backend SELECT").toBe(true);
    expect(await privilegio("contapp_worker", "regla_importacion", "SELECT"), "worker SELECT").toBe(true);
    for (const rol of ROLES_APP) {
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
        expect(await privilegio(rol, "regla_importacion", p), `${rol} ${p}`).toBe(false);
      for (const p of ["INSERT", "UPDATE"])
        expect(await algunaColumna(rol, "regla_importacion", p), `${rol} col ${p}`).toBe(false);
    }
  });

  it("regla_candidata: SELECT solo al backend; el worker, app, platform y el resto no tienen ningun privilegio; nadie escribe", async () => {
    expect(await privilegio("contapp_backend", "regla_candidata", "SELECT"), "backend SELECT").toBe(true);
    for (const rol of ROLES_APP) {
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
        expect(await privilegio(rol, "regla_candidata", p), `${rol} ${p}`).toBe(false);
      for (const p of ["INSERT", "UPDATE"])
        expect(await algunaColumna(rol, "regla_candidata", p), `${rol} col ${p}`).toBe(false);
      if (rol !== "contapp_backend") {
        expect(await privilegio(rol, "regla_candidata", "SELECT"), `${rol} SELECT`).toBe(false);
        expect(await algunaColumna(rol, "regla_candidata", "SELECT"), `${rol} col SELECT`).toBe(false);
      }
    }
  });

  it("escritura directa: el INSERT, UPDATE y DELETE del backend y del worker dan 42501 en las dos tablas", async () => {
    const sqls = [
      `insert into regla_importacion (cliente_id, estado, periodos, periodo_hasta, solicitada_por)
         values ('${cx2.id}', 'en_curso', array['202607']::char(6)[], '202607', '${ux}')`,
      "update regla_importacion set estado = 'fallida'",
      "delete from regla_importacion",
      `insert into regla_candidata (cliente_id, importacion_id, doc_tipo, doc_numero, n_dng, n_total, periodos_con_proveedor, estado)
         values ('${cx.id}', '${impX}', '6', '20111222333', 5, 5, 1, 'pendiente')`,
      "update regla_candidata set estado = 'descartada'",
      "delete from regla_candidata",
    ];
    for (const [db, rol] of [
      [backend, "backend"],
      [worker, "worker"],
    ] as const) {
      for (const s of sqls)
        expect(codigo(await intentar(db, { tenantId: X, userId: ux }, s)), `${rol}: ${s.slice(0, 40)}`).toBe("42501");
    }
  });

  it("el worker lee la importacion de su estudio y no puede leer candidatas (42501)", async () => {
    const r = await worker.withTenant({ tenantId: X }, (tx) =>
      tx.query("select id from regla_importacion where id = $1", [impX]),
    );
    expect(r.rows.map((x) => x.id)).toEqual([impX]);
    expect(codigo(await intentar(worker, { tenantId: X }, "select * from regla_candidata"))).toBe("42501");
  });

  it("DELETE: hay un trigger que lo rechaza y el superusuario si puede borrar (037: borrado del cliente)", async () => {
    for (const t of TABLAS_IMPORTACION) {
      const r = await admin.query(
        `select count(*)::int as n from pg_trigger where tgrelid = to_regclass($1) and not tgisinternal and (tgtype & 8) = 8`,
        [`public.${t}`],
      );
      expect(r.rows[0].n, `${t}: trigger BEFORE DELETE`).toBeGreaterThan(0);
    }
    const imp = await ei.importacion(X, cx2, { estado: "fallida" });
    const cand = await ei.candidata(X, cx2, imp, { docNumero: "20111000009" });
    expect((await admin.query("delete from regla_candidata where id = $1", [cand])).rowCount).toBe(1);
    expect((await admin.query("delete from regla_importacion where id = $1", [imp])).rowCount).toBe(1);
  });
});

// =================================================================================================
describe("0061 · CHECK de regla_importacion (estado, periodos, motivo) y una sola en curso por cliente", () => {
  const insertar = (o: {
    cliente?: ClientePrueba;
    tenant?: string;
    estado?: string;
    periodos?: string[] | null;
    motivo?: string | null;
    usuario?: string;
  }) =>
    enRevertida(admin, async (c) => {
      await c.query(
        `insert into regla_importacion (tenant_id, cliente_id, estado, periodos, periodo_hasta, solicitada_por, motivo)
         values ($1, $2, $3, $4::char(6)[], '202607', $5, $6)`,
        [
          o.tenant ?? X,
          (o.cliente ?? cx2).id,
          o.estado ?? "en_curso",
          o.periodos === undefined ? periodosHasta("202607", 6) : o.periodos,
          o.usuario ?? ux,
          o.motivo ?? null,
        ],
      );
    });
  const cod = (r: Awaited<ReturnType<typeof insertar>>) => (r.ok ? "ok" : r.code);

  it("estado: en_curso, completada y fallida; otro valor da 23514", async () => {
    for (const e of ["en_curso", "completada", "fallida"]) expect(cod(await insertar({ estado: e })), e).toBe("ok");
    for (const e of ["pendiente", "EN_CURSO", ""]) expect(cod(await insertar({ estado: e })), e).toBe("23514");
  });

  it("periodos: de 1 a 12 elementos; 0 o 13 dan 23514; nulo da 23502", async () => {
    expect(cod(await insertar({ periodos: periodosHasta("202607", 1) })), "1").toBe("ok");
    expect(cod(await insertar({ periodos: periodosHasta("202607", 12) })), "12").toBe("ok");
    expect(cod(await insertar({ periodos: [] })), "0").toBe("23514");
    expect(cod(await insertar({ periodos: periodosHasta("202607", 13) })), "13").toBe("23514");
    expect(cod(await insertar({ periodos: null })), "nulo").toBe("23502");
  });

  it("motivo: nulo o uno de los motivos de trabajo; otro valor da 23514", async () => {
    for (const m of MOTIVOS_TRABAJO) expect(cod(await insertar({ estado: "fallida", motivo: m })), m).toBe("ok");
    expect(cod(await insertar({ estado: "fallida", motivo: "inventado" }))).toBe("23514");
    expect(cod(await insertar({ estado: "fallida", motivo: "" }))).toBe("23514");
  });

  it("una sola en curso por cliente (23505); otro cliente, otro estudio o una terminada no chocan", async () => {
    await ei.importacion(X, cx2, { estado: "en_curso" });
    expect(cod(await insertar({ cliente: cx2, estado: "en_curso" })), "misma").toBe("23505");
    expect(cod(await insertar({ cliente: cx2, estado: "completada" })), "completada").toBe("ok");
    expect(cod(await insertar({ cliente: cx2, estado: "fallida" })), "fallida").toBe("ok");
    expect(cod(await insertar({ cliente: cx, estado: "en_curso" })), "otro cliente").toBe("ok");
    expect(cod(await insertar({ cliente: cy, tenant: Y, usuario: uy, estado: "en_curso" })), "otro estudio").toBe("ok");
  });
});

// =================================================================================================
describe("0061 · CHECK de regla_candidata (coherencia, umbral de U-2, razon social) y unica por importacion", () => {
  let reglaX: string;
  beforeAll(async () => {
    reglaX = await ei.regla(X, cx, { docNumero: "20999000777" });
  });
  const BASE = (): Record<string, unknown> => ({
    tenant_id: X,
    cliente_id: cx.id,
    importacion_id: impX,
    doc_tipo: "6",
    doc_numero: "20555000001",
    razon_social: "PROVEEDOR SINTETICO SAC",
    destino_propuesto: "DNG",
    n_dg: 0,
    n_dgng: 0,
    n_dng: 5,
    n_mixto: 0,
    n_total: 5,
    periodos_con_proveedor: 3,
    estado: "pendiente",
  });
  const insertar = (o: Record<string, unknown>) =>
    enRevertida(admin, async (c) => {
      const f = { ...BASE(), ...o };
      const k = Object.keys(f);
      await c.query(
        `insert into regla_candidata (${k.join(", ")}) values (${k.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(f),
      );
    });
  const cod = (r: Awaited<ReturnType<typeof insertar>>) => (r.ok ? "ok" : r.code);

  it("una candidata pendiente valida entra (la prueba no es vacua)", async () => {
    expect(cod(await insertar({}))).toBe("ok");
    expect(cod(await insertar({ destino_propuesto: null, n_dng: 1, n_total: 1 }))).toBe("ok");
  });

  it("destino propuesto: DG, DGNG, DNG o nulo; otro valor da 23514", async () => {
    expect(cod(await insertar({ destino_propuesto: "DG", n_dg: 5, n_dng: 0 }))).toBe("ok");
    expect(cod(await insertar({ destino_propuesto: "DGNG", n_dgng: 5, n_dng: 0 }))).toBe("ok");
    expect(cod(await insertar({ destino_propuesto: "XX" }))).toBe("23514");
    expect(cod(await insertar({ destino_propuesto: "dng" }))).toBe("23514");
  });

  it("estado: pendiente, activada, descartada o reemplazada; otro valor da 23514", async () => {
    const resuelta = { resuelta_por: ux, resuelta_en: new Date() };
    expect(cod(await insertar({ estado: "activada", ...resuelta }))).toBe("ok");
    expect(cod(await insertar({ estado: "descartada", ...resuelta }))).toBe("ok");
    expect(cod(await insertar({ estado: "reemplazada", ...resuelta }))).toBe("ok");
    expect(cod(await insertar({ estado: "aplicada", ...resuelta }))).toBe("23514");
  });

  it("n_total es la suma de los cuatro conteos y ninguno es negativo (23514)", async () => {
    expect(cod(await insertar({ n_total: 6 })), "total mayor").toBe("23514");
    expect(cod(await insertar({ n_total: 4 })), "total menor").toBe("23514");
    expect(cod(await insertar({ n_dg: -1, n_dng: 6, n_total: 5 })), "negativo").toBe("23514");
    expect(cod(await insertar({ destino_propuesto: null, n_dg: 1, n_dgng: 1, n_dng: 1, n_mixto: 2, n_total: 5 }))).toBe("ok");
  });

  it("umbral de U-2: el destino propuesto tiene al menos 2 comprobantes y 80 % del total (enteros: 5n >= 4t)", async () => {
    const c = (dest: string, n: Record<string, number>, total: number) =>
      insertar({ destino_propuesto: dest, n_dg: 0, n_dgng: 0, n_dng: 0, n_mixto: 0, ...n, n_total: total });
    expect(cod(await c("DNG", { n_dng: 4, n_dg: 1 }, 5)), "4 de 5 = 80 % justo").toBe("ok");
    expect(cod(await c("DNG", { n_dng: 2 }, 2)), "2 de 2").toBe("ok");
    expect(cod(await c("DNG", { n_dng: 1 }, 1)), "1 de 1: bajo el minimo de 2").toBe("23514");
    expect(cod(await c("DNG", { n_dng: 3, n_dg: 1 }, 4)), "3 de 4 = 75 %").toBe("23514");
    expect(cod(await c("DNG", { n_dng: 3, n_dg: 2 }, 5)), "3 de 5 = 60 %").toBe("23514");
    expect(cod(await c("DNG", { n_dng: 4, n_mixto: 2 }, 6)), "los mixtos bajan el porcentaje").toBe("23514");
    expect(cod(await c("DG", { n_dg: 1, n_dng: 4 }, 5)), "el destino propuesto no es el dominante").toBe("23514");
    expect(cod(await c("DGNG", { n_dgng: 2, n_dg: 0 }, 2)), "DGNG 2 de 2").toBe("ok");
  });

  it("regla_id, resuelta_por y resuelta_en solo si la candidata no esta pendiente (23514)", async () => {
    expect(cod(await insertar({ regla_id: reglaX }))).toBe("23514");
    expect(cod(await insertar({ resuelta_por: ux }))).toBe("23514");
    expect(cod(await insertar({ resuelta_en: new Date() }))).toBe("23514");
    expect(cod(await insertar({ estado: "activada", regla_id: reglaX, resuelta_por: ux, resuelta_en: new Date() }))).toBe("ok");
    expect(cod(await insertar({ estado: "descartada", resuelta_por: ux, resuelta_en: new Date() }))).toBe("ok");
  });

  it("razon social: nula, hasta 200 caracteres, sin controles ni bidireccionales (D-11); si no, 23514", async () => {
    expect(cod(await insertar({ razon_social: null }))).toBe("ok");
    expect(cod(await insertar({ razon_social: "Ñandú Ltda. & Cía S.A.C." }))).toBe("ok");
    expect(cod(await insertar({ razon_social: "A".repeat(200) }))).toBe("ok");
    expect(cod(await insertar({ razon_social: "A".repeat(201) })), "201").toBe("23514");
    for (const [nombre, valor] of [
      ["campana", "A\u0007B"],
      ["salto de linea", "A\nB"],
      ["tabulador", "A\tB"],
      ["DEL", "A\u007fB"],
      ["RLO", "A‮B"],
      ["isolate", "A⁦B"],
      ["LRM", "A‎B"],
    ] as const)
      expect(cod(await insertar({ razon_social: valor })), nombre).toBe("23514");
  });

  it("unica (importacion, doc_tipo, doc_numero): la misma candidata dos veces da 23505; otra importacion u otro tipo, no", async () => {
    await ei.candidata(X, cx, impX, { docNumero: "20555000002" });
    expect(cod(await insertar({ doc_numero: "20555000002" })), "repetida").toBe("23505");
    expect(cod(await insertar({ doc_numero: "20555000002", doc_tipo: "1" })), "otro tipo").toBe("ok");
    const otra = await ei.importacion(X, cx, { estado: "fallida" });
    expect(cod(await insertar({ doc_numero: "20555000002", importacion_id: otra })), "otra importacion").toBe("ok");
  });

  it("FK compuestas: candidata de otro cliente, de otro estudio o con regla de otro estudio es imposible (23503)", async () => {
    expect(cod(await insertar({ cliente_id: cx2.id })), "cliente distinto al de la importacion").toBe("23503");
    expect(cod(await insertar({ tenant_id: Y, cliente_id: cy.id })), "estudio distinto al de la importacion").toBe("23503");
    expect(cod(await insertar({ tenant_id: Y })), "cliente de X bajo el estudio Y").toBe("23503");
    const reglaY = await ei.regla(Y, cy, { docNumero: "20999000778" });
    expect(
      cod(await insertar({ estado: "activada", regla_id: reglaY, resuelta_por: ux, resuelta_en: new Date() })),
      "regla de otro estudio",
    ).toBe("23503");
  });

  it("la importacion de un cliente de otro estudio es imposible (23503)", async () => {
    const r = await enRevertida(admin, async (c) => {
      await c.query(
        `insert into regla_importacion (tenant_id, cliente_id, estado, periodos, periodo_hasta, solicitada_por)
         values ($1, $2, 'en_curso', array['202607']::char(6)[], '202607', $3)`,
        [X, cy.id, ux],
      );
    });
    expect(cod(r)).toBe("23503");
  });
});

// =================================================================================================
describe("0061 · aislamiento entre estudios (CA-7): sin withTenant no se ve nada", () => {
  it("cada estudio ve solo lo suyo en las dos tablas, aunque el proveedor y el RUC del cliente sean iguales", async () => {
    for (const [db, tenant, impPropia, impAjena, candPropia, candAjena] of [
      [backend, X, impX, impY, candX, candY],
      [backend, Y, impY, impX, candY, candX],
    ] as const) {
      const i = await db.withTenant({ tenantId: tenant }, (tx) => tx.query("select id from regla_importacion"));
      expect(i.rows.map((x) => x.id), "tabla vacia o sin RLS").toContain(impPropia);
      expect(i.rows.map((x) => x.id)).not.toContain(impAjena);
      const c = await db.withTenant({ tenantId: tenant }, (tx) => tx.query("select id from regla_candidata"));
      expect(c.rows.map((x) => x.id)).toContain(candPropia);
      expect(c.rows.map((x) => x.id)).not.toContain(candAjena);
      const porId = await db.withTenant({ tenantId: tenant }, (tx) =>
        tx.query("select 1 from regla_candidata where id = $1", [candAjena]),
      );
      expect(porId.rowCount).toBe(0);
    }
  });

  it("sin withTenant el backend ve 0 filas y el worker no ve importaciones ni (por permiso) candidatas", async () => {
    for (const t of TABLAS_IMPORTACION)
      expect(await filasRaw(app, "contapp_backend", `select 1 from ${t}`), `backend sin contexto: ${t}`).toEqual([]);
    expect(await filasRaw(app, "contapp_worker", "select 1 from regla_importacion")).toEqual([]);
    const w = await intentarRaw(app, "contapp_worker", "select 1 from regla_candidata");
    expect(w.ok ? "ok" : w.code).toBe("42501");
  });

  it("una candidata del cliente A no se ve por cliente_id del cliente B del mismo estudio", async () => {
    const r = await backend.withTenant({ tenantId: X }, (tx) =>
      tx.query("select 1 from regla_candidata where cliente_id = $1", [cx2.id]),
    );
    expect(r.rowCount).toBe(0);
  });
});

// =================================================================================================
describe("0061 · regla_aprendida.origen (D-5, D-7): solo la funcion de activar escribe 'importacion'", () => {
  it("CHECK: contador o importacion (el superusuario ya lo respeta); otro valor da 23514", async () => {
    const ins = (origen: string) =>
      enRevertida(admin, async (c) => {
        await c.query(
          `insert into regla_aprendida (tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por, origen)
           values ($1, $2, '6', '20444000001', 'DNG', true, 1, '202607', $3, $3, $4)`,
          [X, cx2.id, ux, origen],
        );
      });
    expect((await ins("contador")).ok).toBe(true);
    expect((await ins("importacion")).ok).toBe(true);
    const mala = await ins("automatico");
    expect(mala.ok ? "ok" : mala.code).toBe("23514");
  });

  it("el INSERT del backend por columnas sin origen funciona y deja 'contador'; con origen da 42501", async () => {
    const sin = await backend.withTenant({ tenantId: X, userId: ux }, async (tx) => {
      const r = await tx.query(
        `insert into regla_aprendida (cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por)
         values ($1, '6', '20444000002', 'DNG', true, 1, '202607', $2, $2)`,
        [cx2.id, ux],
      );
      return r.rowCount;
    });
    expect(sin).toBe(1);
    const fila = (await admin.query("select origen from regla_aprendida where cliente_id = $1 and doc_numero = '20444000002'", [cx2.id])).rows;
    expect(fila).toEqual([{ origen: "contador" }]);
    const con = await intentar(
      backend,
      { tenantId: X, userId: ux },
      `insert into regla_aprendida (cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por, origen)
       values ($1, '6', '20444000003', 'DNG', true, 1, '202607', $2, $2, 'importacion')`,
      [cx2.id, ux],
    );
    expect(codigo(con)).toBe("42501");
  });

  it("el backend no tiene INSERT ni UPDATE sobre la columna origen y si sobre las que usa «Recordar»", async () => {
    const q = async (priv: string) =>
      (
        await admin.query(
          `select a.attname::text as c from pg_attribute a
            where a.attrelid = 'public.regla_aprendida'::regclass and a.attnum > 0 and not a.attisdropped
              and has_column_privilege('contapp_backend', 'public.regla_aprendida'::regclass, a.attnum, $1::text)`,
          [priv],
        )
      ).rows.map((x) => x.c as string);
    const insert = await q("INSERT");
    expect(insert).not.toContain("origen");
    for (const k of ["cliente_id", "doc_tipo", "doc_numero", "destino", "activa", "version", "periodo_aprendido", "creada_por", "actualizada_por"])
      expect(insert, k).toContain(k);
    expect(await q("UPDATE")).not.toContain("origen");
    const id = await ei.regla(X, cx2, { docNumero: "20444000004" });
    expect(codigo(await intentar(backend, { tenantId: X, userId: ux }, "update regla_aprendida set origen = 'importacion' where id = $1", [id]))).toBe("42501");
  });

  it("la auditoria regla.creada de un «Recordar» lleva origen 'contador' y nada personal en los datos", async () => {
    const { filas } = await ei.capturar(X, "regla.creada", () =>
      backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
        tx.query(
          `insert into regla_aprendida (cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por)
           values ($1, '6', '20444000005', 'DNG', true, 1, '202607', $2, $2)`,
          [cx2.id, ux],
        ),
      ),
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]!.datos).toMatchObject({ destino: "DNG", activa: true, origen: "contador" });
    expect(JSON.stringify(filas[0]!.datos)).not.toContain("20444000005");
  });
});

// =================================================================================================
describe("0061 · CHECK de acciones de auditoria y de codigos del motor", () => {
  it("auditoria_accion_valida admite regla.historial_importado y regla.candidata_descartada y sigue rechazando las ajenas (23514)", async () => {
    const ins = (accion: string) =>
      enRevertida(admin, async (c) => {
        await c.query(
          `insert into auditoria (tenant_id, actor_tipo, usuario_id, accion, cliente_id, entidad, entidad_id, datos)
           values ($1, 'usuario', $2, $3, $4, 'regla_importacion', $5, '{}'::jsonb)`,
          [X, ux, accion, cx.id, impX],
        );
      });
    for (const a of ["regla.historial_importado", "regla.candidata_descartada", "regla.creada", "regla.editada"])
      expect((await ins(a)).ok, a).toBe(true);
    const mala = await ins("regla.importada");
    expect(mala.ok ? "ok" : mala.code).toBe("23514");
  });

  it("estudio_regla_motor admite R-STD; sigue rechazando otros codigos (23514)", async () => {
    const ins = (c: string) =>
      intentar(
        backend,
        { tenantId: X, userId: ux },
        "insert into estudio_regla_motor (codigo, activa, actualizada_por) values ($1, false, $2)",
        [c, ux],
      );
    expect(codigo(await ins("R-STD"))).toBe("ok");
    for (const c of ["R-STDX", "r-std", "R-XXX"]) expect(codigo(await ins(c)), c).toBe("23514");
  });
});
