// Spec 027 (T3, rojo): tablas de la migracion 0069 (`gnd_palabra_global`, `gnd_global_historial`, `gnd_palabra_estudio`,
// `gnd_global_desactivada`, `gnd_config`, `gnd_cliente_categorias`, `gnd_ciiu`, la semilla y el CHECK de acciones de auditoria) contra la
// BD real. Cubre R-6, D-2, CA-7, CA-14: columnas y tipos, FK compuestas, unicas, RLS FORCE de las cinco del estudio, grants (backend y
// worker solo SELECT; la escritura de plataforma solo de contapp_auth; nadie escribe directo), historial global solo de insercion,
// CHECK de palabra, categoria, excepciones, umbral, CIIU y RUC, la semilla del plan y el aislamiento entre estudios. Hasta T10 fallan
// por tabla inexistente. Modelo: `prorrata-tablas.spec.ts`. Contrato en `gnd-soporte.ts`.
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
  ACCIONES_GND,
  CATEGORIAS,
  EscenarioGnd,
  SEMILLA,
  TABLAS_GND,
  TABLAS_GND_ESTUDIO,
  TABLAS_GND_PLATAFORMA,
  type ClientePrueba,
} from "./gnd-soporte";

let admin: Pool;
let app: Pool;
let eg: EscenarioGnd;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let Z: string; // estudio sin filas (base de las inserciones validas)
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let uy: string;
let globalA: string; // global propia de la prueba
let palX: string;
let palY: string;
let compraX: string;
let compraY: string;
let historialId: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  eg = new EscenarioGnd(admin);
  X = (await eg.estudio()).id;
  Y = (await eg.estudio()).id;
  Z = (await eg.estudio()).id;
  cx = await eg.cliente(X);
  cx2 = await eg.cliente(X);
  cy = await eg.cliente(Y);
  ux = await eg.usuarioDe(X);
  uy = await eg.usuarioDe(Y);
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
  // Estado base de lectura: una global, y por estudio una propia, una global desactivada, el umbral, las categorias y un CIIU.
  const g = await eg.palabraGlobal({ palabra: eg.palabraNueva() });
  globalA = g.id;
  palX = (await eg.palabraEstudio(X, { palabra: "audifono" })).id;
  palY = (await eg.palabraEstudio(Y, { palabra: "audifono" })).id;
  await eg.desactivadaGlobal(X, globalA);
  await eg.desactivadaGlobal(Y, globalA);
  await eg.config(X, 5);
  await eg.config(Y, 7);
  await eg.categorias(X, cx, { permitidas: ["juguetes"], quitadas: [] });
  await eg.categorias(Y, cy, { permitidas: [], quitadas: ["calzado-ropa"] });
  await eg.ciiu(X, "20100070970", "4752");
  await eg.ciiu(Y, "20100070970", "4771");
  compraX = (await eg.compra(X, cx)).id;
  compraY = (await eg.compra(Y, cy)).id;
  historialId = (
    await admin.query(
      `insert into gnd_global_historial (palabra_global_id, accion, antes, despues, usuario_id)
       values ($1, 'agregada', null, '{"palabra":"x"}'::jsonb, $2) returning id`,
      [globalA, ux],
    )
  ).rows[0].id as string;
});
afterAll(async () => {
  await eg?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close(), eg?.cerrar()].map((p) =>
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
              i.indisunique as unico, i.indisprimary as pk
         from pg_index i where i.indrelid = to_regclass($1)`,
      [`public.${tabla}`],
    )
  ).rows as { columnas: string[]; unico: boolean; pk: boolean }[];

// =================================================================================================
describe("0069 · columnas y tipos (plan: Contratos · BD)", () => {
  const ESPERADAS: Record<string, string[]> = {
    gnd_palabra_global: [
      "id",
      "palabra",
      "categoria",
      "excepciones",
      "activa",
      "version",
      "actualizada_en",
    ],
    gnd_global_historial: [
      "id",
      "palabra_global_id",
      "accion",
      "antes",
      "despues",
      "usuario_id",
      "ocurrida_en",
    ],
    gnd_palabra_estudio: [
      "id",
      "tenant_id",
      "palabra",
      "categoria",
      "excepciones",
      "origen",
      "activa",
      "version",
      "creado_por",
      "compra_origen_id",
      "creada_en",
      "actualizada_en",
    ],
    gnd_global_desactivada: [
      "tenant_id",
      "palabra_global_id",
      "usuario_id",
      "desactivada_en",
    ],
    gnd_config: ["tenant_id", "umbral", "version"],
    gnd_cliente_categorias: [
      "tenant_id",
      "cliente_id",
      "permitidas",
      "quitadas",
      "version",
    ],
    gnd_ciiu: ["tenant_id", "ruc", "ciiu", "consultado_en"],
  };
  for (const [tabla, esperadas] of Object.entries(ESPERADAS)) {
    it(`${tabla}: tiene todas las columnas del plan y ninguna termina en _at (013 usa _en)`, async () => {
      const nombres = (await columnasDe(tabla)).map((c) => c.column_name);
      expect(
        nombres,
        `falta la tabla ${tabla} (migracion 0069)`,
      ).not.toHaveLength(0);
      expect(nombres).toEqual(expect.arrayContaining(esperadas));
      expect(nombres.filter((n) => /_at$/.test(n))).toEqual([]);
    });
  }

  it("claves: id con uuid_v7 por defecto en las tres con id; tenant_id con app.tenant_id por defecto en las cinco del estudio", async () => {
    for (const t of [
      "gnd_palabra_global",
      "gnd_global_historial",
      "gnd_palabra_estudio",
    ]) {
      const c = Object.fromEntries(
        (await columnasDe(t)).map((x) => [x.column_name, x]),
      );
      expect(c.id, `falta ${t}`).toBeDefined();
      expect(c.id!.defecto, t).toMatch(/uuid_v7\(\)/);
    }
    for (const t of TABLAS_GND_ESTUDIO) {
      const c = Object.fromEntries(
        (await columnasDe(t)).map((x) => [x.column_name, x]),
      );
      expect(c.tenant_id, `falta ${t}`).toBeDefined();
      expect(c.tenant_id!.defecto, t).toMatch(/app\.tenant_id/);
    }
  });

  it("las dos de plataforma no tienen tenant_id (como `plan`)", async () => {
    for (const t of TABLAS_GND_PLATAFORMA) {
      const nombres = (await columnasDe(t)).map((c) => c.column_name);
      expect(nombres, `falta ${t}`).not.toHaveLength(0);
      expect(nombres, t).not.toContain("tenant_id");
    }
  });

  it("tipos: categoria y palabra text; excepciones, permitidas y quitadas text[]; umbral smallint; ruc char(11); ciiu char(4) nulo; consultado_en timestamptz", async () => {
    const g = Object.fromEntries(
      (await columnasDe("gnd_palabra_global")).map((x) => [x.column_name, x]),
    );
    expect(g.palabra?.data_type, "falta gnd_palabra_global").toBe("text");
    expect(g.categoria?.data_type).toBe("text");
    expect(g.excepciones?.udt_name).toBe("_text");
    expect([g.activa?.data_type, g.activa?.is_nullable]).toEqual([
      "boolean",
      "NO",
    ]);
    expect([g.version?.data_type, g.version?.is_nullable]).toEqual([
      "integer",
      "NO",
    ]);
    const e = Object.fromEntries(
      (await columnasDe("gnd_palabra_estudio")).map((x) => [x.column_name, x]),
    );
    expect(e.excepciones?.udt_name, "falta gnd_palabra_estudio").toBe("_text");
    for (const k of [
      "palabra",
      "categoria",
      "origen",
      "activa",
      "version",
      "creado_por",
    ])
      expect(e[k]?.is_nullable, k).toBe("NO");
    expect(e.compra_origen_id?.is_nullable).toBe("YES");
    const cfg = Object.fromEntries(
      (await columnasDe("gnd_config")).map((x) => [x.column_name, x]),
    );
    expect([
      cfg.umbral?.data_type,
      cfg.umbral?.is_nullable,
      cfg.version?.data_type,
    ]).toEqual(["smallint", "NO", "integer"]);
    const cat = Object.fromEntries(
      (await columnasDe("gnd_cliente_categorias")).map((x) => [
        x.column_name,
        x,
      ]),
    );
    expect(cat.permitidas?.udt_name, "falta gnd_cliente_categorias").toBe(
      "_text",
    );
    expect(cat.quitadas?.udt_name).toBe("_text");
    for (const k of ["permitidas", "quitadas", "version"])
      expect(cat[k]?.is_nullable, k).toBe("NO");
    const c = Object.fromEntries(
      (await columnasDe("gnd_ciiu")).map((x) => [x.column_name, x]),
    );
    expect([c.ruc?.data_type, c.ruc?.largo, c.ruc?.is_nullable]).toEqual([
      "character",
      11,
      "NO",
    ]);
    expect([c.ciiu?.data_type, c.ciiu?.largo, c.ciiu?.is_nullable]).toEqual([
      "character",
      4,
      "YES",
    ]);
    expect(c.consultado_en?.is_nullable).toBe("NO");
    const h = Object.fromEntries(
      (await columnasDe("gnd_global_historial")).map((x) => [x.column_name, x]),
    );
    expect([h.antes?.udt_name, h.despues?.udt_name]).toEqual([
      "jsonb",
      "jsonb",
    ]);
    expect([h.accion?.is_nullable, h.usuario_id?.is_nullable]).toEqual([
      "NO",
      "NO",
    ]);
  });
});

// =================================================================================================
describe("0069 · FK compuestas, claves y unicas (D-2)", () => {
  const FKS: [string, string, string[]][] = [
    ["gnd_global_historial", "gnd_palabra_global", ["palabra_global_id"]],
    ["gnd_global_historial", "usuario", ["usuario_id"]],
    ["gnd_palabra_estudio", "usuario", ["creado_por"]],
    ["gnd_palabra_estudio", "compra", ["tenant_id", "compra_origen_id"]],
    ["gnd_global_desactivada", "gnd_palabra_global", ["palabra_global_id"]],
    ["gnd_global_desactivada", "usuario", ["usuario_id"]],
    ["gnd_cliente_categorias", "cliente", ["tenant_id", "cliente_id"]],
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

  const UNICAS: [string, string[], boolean][] = [
    ["gnd_palabra_global", ["palabra"], false],
    ["gnd_palabra_estudio", ["tenant_id", "palabra"], false],
    ["gnd_global_desactivada", ["tenant_id", "palabra_global_id"], true],
    ["gnd_config", ["tenant_id"], true],
    ["gnd_cliente_categorias", ["tenant_id", "cliente_id"], true],
    ["gnd_ciiu", ["tenant_id", "ruc"], true],
  ];
  for (const [tabla, columnas, pk] of UNICAS) {
    it(`${tabla}: ${pk ? "clave primaria" : "unica"} por (${columnas.join(", ")})`, async () => {
      const i = await indices(tabla);
      expect(i, `falta la tabla ${tabla}`).not.toHaveLength(0);
      expect(
        i.some(
          (x) =>
            x.unico && x.pk === pk && x.columnas.join() === columnas.join(),
        ),
        JSON.stringify(i),
      ).toBe(true);
    });
  }
});

// =================================================================================================
describe("0069 · RLS ENABLE + FORCE, dueno y tenant_isolation en las cinco del estudio (R-6)", () => {
  for (const tabla of TABLAS_GND_ESTUDIO) {
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

  for (const tabla of TABLAS_GND_PLATAFORMA) {
    it(`${tabla}: dueno contapp_migrator`, async () => {
      const t = await admin.query(
        `select o.rolname as dueno from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass($1)`,
        [`public.${tabla}`],
      );
      expect(t.rows, `falta la tabla ${tabla}`).toEqual([
        { dueno: "contapp_migrator" },
      ]);
    });
  }
});

// =================================================================================================
describe("0069 · grants: backend y worker solo leen; la plataforma la escribe solo contapp_auth; nadie escribe directo (R-6)", () => {
  it("las siete: ningun rol de la app tiene INSERT, UPDATE, DELETE ni TRUNCATE (ni por columna)", async () => {
    for (const t of TABLAS_GND)
      for (const rol of ["contapp_backend", "contapp_worker", "contapp_app"]) {
        for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
          expect(await privilegio(rol, t, p), `${rol} ${p} ${t}`).toBe(false);
        for (const p of ["INSERT", "UPDATE"])
          expect(await algunaColumna(rol, t, p), `${rol} col ${p} ${t}`).toBe(
            false,
          );
      }
  });

  it("backend y worker tienen SELECT en las siete", async () => {
    for (const t of TABLAS_GND)
      for (const rol of ["contapp_backend", "contapp_worker"])
        expect(await privilegio(rol, t, "SELECT"), `${rol} SELECT ${t}`).toBe(
          true,
        );
  });

  it("contapp_app, platform, enumerador y registrador no tienen ningun privilegio sobre las siete; contapp_auth ninguno sobre las cinco del estudio", async () => {
    for (const t of TABLAS_GND)
      for (const rol of [
        "contapp_app",
        "contapp_platform",
        "contapp_enumerador",
        "contapp_registrador",
      ]) {
        expect(await privilegio(rol, t, "SELECT"), `${rol} SELECT ${t}`).toBe(
          false,
        );
        expect(
          await algunaColumna(rol, t, "SELECT"),
          `${rol} col SELECT ${t}`,
        ).toBe(false);
      }
    for (const t of TABLAS_GND_ESTUDIO)
      expect(
        await privilegio("contapp_auth", t, "SELECT"),
        `contapp_auth SELECT ${t}`,
      ).toBe(false);
  });

  it("contapp_auth (dueno de las funciones de plataforma): SELECT, INSERT y UPDATE en gnd_palabra_global; SELECT e INSERT en gnd_global_historial; nunca DELETE ni TRUNCATE", async () => {
    for (const p of ["SELECT", "INSERT", "UPDATE"])
      expect(
        await privilegio("contapp_auth", "gnd_palabra_global", p),
        `contapp_auth ${p} gnd_palabra_global`,
      ).toBe(true);
    for (const p of ["SELECT", "INSERT"])
      expect(
        await privilegio("contapp_auth", "gnd_global_historial", p),
        `contapp_auth ${p} gnd_global_historial`,
      ).toBe(true);
    for (const p of ["UPDATE", "DELETE", "TRUNCATE"])
      expect(
        await privilegio("contapp_auth", "gnd_global_historial", p),
        `contapp_auth ${p} gnd_global_historial`,
      ).toBe(false);
    for (const p of ["DELETE", "TRUNCATE"])
      expect(
        await privilegio("contapp_auth", "gnd_palabra_global", p),
        `contapp_auth ${p} gnd_palabra_global`,
      ).toBe(false);
  });

  it("escritura directa: el INSERT, UPDATE y DELETE del backend y del worker dan 42501 en las siete tablas (CA-7)", async () => {
    const sqls = [
      "insert into gnd_palabra_global (palabra, categoria) values ('directa', 'juguetes')",
      "update gnd_palabra_global set activa = false",
      "delete from gnd_palabra_global",
      `insert into gnd_global_historial (palabra_global_id, accion, usuario_id) values ('${globalA}', 'editada', '${ux}')`,
      "update gnd_global_historial set accion = 'agregada'",
      "delete from gnd_global_historial",
      `insert into gnd_palabra_estudio (palabra, categoria, origen, creado_por) values ('directa', 'juguetes', 'manual', '${ux}')`,
      "update gnd_palabra_estudio set activa = false",
      "delete from gnd_palabra_estudio",
      `insert into gnd_global_desactivada (palabra_global_id, usuario_id) values ('${globalA}', '${ux}')`,
      "update gnd_global_desactivada set usuario_id = usuario_id",
      "delete from gnd_global_desactivada",
      "insert into gnd_config (umbral, version) values (9, 1)",
      "update gnd_config set umbral = 9",
      "delete from gnd_config",
      `insert into gnd_cliente_categorias (cliente_id, permitidas, quitadas, version) values ('${cx2.id}', '{}', '{}', 1)`,
      "update gnd_cliente_categorias set permitidas = '{juguetes}'",
      "delete from gnd_cliente_categorias",
      "insert into gnd_ciiu (ruc, ciiu) values ('20100070971', '4752')",
      "update gnd_ciiu set ciiu = '4771'",
      "delete from gnd_ciiu",
    ];
    for (const [db, rol] of [
      [backend, "backend"],
      [worker, "worker"],
    ] as const) {
      for (const s of sqls)
        expect(
          codigo(await intentar(db, { tenantId: X, userId: ux }, s)),
          `${rol}: ${s.slice(0, 60)}`,
        ).toBe("42501");
    }
  });
});

// =================================================================================================
describe("0069 · historial global: solo insercion (D-2)", () => {
  it("hay un trigger BEFORE UPDATE y uno BEFORE DELETE en gnd_global_historial", async () => {
    const r = await admin.query(
      `select count(*) filter (where (tgtype & 8) = 8)::int as borra, count(*) filter (where (tgtype & 16) = 16)::int as actualiza
         from pg_trigger where tgrelid = to_regclass('public.gnd_global_historial') and not tgisinternal`,
    );
    expect(r.rows[0].borra, "trigger BEFORE DELETE").toBeGreaterThan(0);
    expect(r.rows[0].actualiza, "trigger BEFORE UPDATE").toBeGreaterThan(0);
  });

  it("el dueno (contapp_migrator, no superusuario) no puede actualizar ni borrar una fila del historial (42501 por el trigger)", async () => {
    for (const sql of [
      "update gnd_global_historial set accion = 'editada' where id = $1",
      "delete from gnd_global_historial where id = $1",
    ]) {
      const r = await enRevertida(admin, async (c) => {
        await c.query("SET LOCAL ROLE contapp_migrator");
        await c.query(sql, [historialId]);
      });
      expect(r.ok ? "ok" : r.code, sql).toBe("42501");
    }
  });
});

// =================================================================================================
// Inserciones con el superusuario (pasa por CHECK, FK, unicas y triggers) en una transaccion que siempre se revierte.
type Fila = Record<string, unknown>;
const BASES: Record<string, () => Fila> = {
  gnd_palabra_global: () => ({
    palabra: "t3basevalida",
    categoria: "juguetes",
    excepciones: [],
    activa: true,
    version: 1,
  }),
  gnd_global_historial: () => ({
    palabra_global_id: globalA,
    accion: "editada",
    antes: null,
    despues: null,
    usuario_id: ux,
  }),
  gnd_palabra_estudio: () => ({
    tenant_id: X,
    palabra: "t3basevalida",
    categoria: "entretenimiento",
    excepciones: [],
    origen: "manual",
    activa: true,
    version: 1,
    creado_por: ux,
  }),
  gnd_global_desactivada: () => ({
    tenant_id: Z,
    palabra_global_id: globalA,
    usuario_id: ux,
  }),
  gnd_config: () => ({ tenant_id: Z, umbral: 3, version: 1 }),
  gnd_cliente_categorias: () => ({
    tenant_id: X,
    cliente_id: cx2.id,
    permitidas: ["juguetes"],
    quitadas: ["calzado-ropa"],
    version: 1,
  }),
  gnd_ciiu: () => ({
    tenant_id: Z,
    ruc: "20100070971",
    ciiu: "4752",
  }),
};
const ARREGLOS = new Set(["excepciones", "permitidas", "quitadas"]);
const JSONB = new Set(["antes", "despues"]);
const insertar = (tabla: string, o: Fila = {}) =>
  enRevertida(admin, async (c) => {
    const f = { ...BASES[tabla]!(), ...o };
    const k = Object.keys(f);
    const marcas = k.map((n, i) => {
      if (ARREGLOS.has(n)) return `$${i + 1}::text[]`;
      if (JSONB.has(n)) return `$${i + 1}::jsonb`;
      return `$${i + 1}`;
    });
    await c.query(
      `insert into ${tabla} (${k.join(", ")}) values (${marcas.join(", ")})`,
      Object.values(f).map((v) =>
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? JSON.stringify(v)
          : v,
      ),
    );
  });
const cod = (r: Awaited<ReturnType<typeof insertar>>) => (r.ok ? "ok" : r.code);

const PALABRAS_MALAS: [string, string][] = [
  ["ab", "2 caracteres"],
  ["a".repeat(41), "41 caracteres"],
  ["Zapato", "mayuscula"],
  ["dos palabras", "espacio"],
  ["ñandu", "enie"],
  ["cámara", "tilde"],
  ["con-guion", "guion"],
  ["con.punto", "punto"],
  ["", "vacia"],
];
const EXCEPCIONES_MALAS: [string[], string][] = [
  [["a", "b", "c", "d", "e", "f"], "6 frases"],
  [["Seguridad"], "mayuscula"],
  [["uno dos tres cuatro"], "4 palabras"],
  [[""], "frase vacia"],
  [["uno  dos"], "doble espacio"],
  [[" seguridad"], "espacio inicial"],
  [["seguridad "], "espacio final"],
  [["acción"], "tilde"],
  [["con-guion"], "guion"],
];

describe("0069 · CHECK de gnd_palabra_global (palabra, categoria, excepciones, version) y unica", () => {
  it("una global valida entra (la prueba no es vacua), con 5 excepciones de hasta 3 palabras y con la palabra de 3 y de 40 caracteres", async () => {
    expect(cod(await insertar("gnd_palabra_global"))).toBe("ok");
    expect(
      cod(
        await insertar("gnd_palabra_global", {
          excepciones: [
            "seguridad",
            "punta de acero",
            "a tierra",
            "jebe",
            "x1 y2 z3",
          ],
        }),
      ),
    ).toBe("ok");
    for (const p of ["abc", "a".repeat(40), "abc123", "123"])
      expect(cod(await insertar("gnd_palabra_global", { palabra: p })), p).toBe(
        "ok",
      );
  });

  it("palabra: de 3 a 40 caracteres [a-z0-9]; mayuscula, espacio, tilde, enie, signos, vacia, corta o larga dan 23514", async () => {
    for (const [p, n] of PALABRAS_MALAS)
      expect(cod(await insertar("gnd_palabra_global", { palabra: p })), n).toBe(
        "23514",
      );
  });

  it("categoria: una de las 6; otra, otra capitalizacion o variante da 23514", async () => {
    for (const c of CATEGORIAS)
      expect(
        cod(await insertar("gnd_palabra_global", { categoria: c })),
        c,
      ).toBe("ok");
    for (const c of ["otra", "Juguetes", "calzado_ropa", "calzado", ""])
      expect(
        cod(await insertar("gnd_palabra_global", { categoria: c })),
        c,
      ).toBe("23514");
  });

  it("excepciones: hasta 5 frases de 1 a 3 palabras normalizadas; el resto da 23514", async () => {
    for (const [e, n] of EXCEPCIONES_MALAS)
      expect(
        cod(await insertar("gnd_palabra_global", { excepciones: e })),
        n,
      ).toBe("23514");
  });

  it("version: 1 o mas; 0 y negativa dan 23514", async () => {
    for (const v of [0, -1])
      expect(
        cod(await insertar("gnd_palabra_global", { version: v })),
        String(v),
      ).toBe("23514");
  });

  it("unica por palabra: repetir una de la semilla da 23505", async () => {
    expect(
      cod(await insertar("gnd_palabra_global", { palabra: "zapatilla" })),
    ).toBe("23505");
  });
});

describe("0069 · CHECK de gnd_global_historial (accion, FK)", () => {
  it("agregada y editada entran, con antes y despues nulos o JSON; otra accion da 23514", async () => {
    for (const a of ["agregada", "editada"])
      expect(
        cod(await insertar("gnd_global_historial", { accion: a })),
        a,
      ).toBe("ok");
    expect(
      cod(
        await insertar("gnd_global_historial", {
          antes: { version: 1 },
          despues: { version: 2 },
        }),
      ),
    ).toBe("ok");
    for (const a of ["borrada", "AGREGADA", ""])
      expect(
        cod(await insertar("gnd_global_historial", { accion: a })),
        a,
      ).toBe("23514");
  });

  it("palabra o usuario inexistentes dan 23503", async () => {
    expect(
      cod(
        await insertar("gnd_global_historial", {
          palabra_global_id: "00000000-0000-4000-8000-000000000001",
        }),
      ),
    ).toBe("23503");
    expect(
      cod(
        await insertar("gnd_global_historial", {
          usuario_id: "00000000-0000-4000-8000-000000000002",
        }),
      ),
    ).toBe("23503");
  });
});

describe("0069 · CHECK de gnd_palabra_estudio (palabra, categoria, excepciones, origen, version, compra de origen) y unica", () => {
  it("una propia valida entra (la prueba no es vacua), activa o no, y la misma palabra en otro estudio no choca", async () => {
    expect(cod(await insertar("gnd_palabra_estudio"))).toBe("ok");
    expect(cod(await insertar("gnd_palabra_estudio", { activa: false }))).toBe(
      "ok",
    );
    expect(
      cod(
        await insertar("gnd_palabra_estudio", {
          tenant_id: Z,
          palabra: "audifono",
        }),
      ),
      "la palabra de X y de Y en un tercer estudio",
    ).toBe("ok");
  });

  it("palabra, categoria y excepciones: las mismas reglas que la global (23514)", async () => {
    for (const [p, n] of PALABRAS_MALAS)
      expect(
        cod(await insertar("gnd_palabra_estudio", { palabra: p })),
        n,
      ).toBe("23514");
    for (const c of CATEGORIAS)
      expect(
        cod(await insertar("gnd_palabra_estudio", { categoria: c })),
        c,
      ).toBe("ok");
    for (const c of ["otra", "Juguetes", ""])
      expect(
        cod(await insertar("gnd_palabra_estudio", { categoria: c })),
        c,
      ).toBe("23514");
    for (const [e, n] of EXCEPCIONES_MALAS)
      expect(
        cod(await insertar("gnd_palabra_estudio", { excepciones: e })),
        n,
      ).toBe("23514");
  });

  it("origen: manual o aprendida; otro valor da 23514; version 1 o mas", async () => {
    for (const o of ["borrada", "MANUAL", ""])
      expect(cod(await insertar("gnd_palabra_estudio", { origen: o })), o).toBe(
        "23514",
      );
    for (const v of [0, -1])
      expect(
        cod(await insertar("gnd_palabra_estudio", { version: v })),
        String(v),
      ).toBe("23514");
  });

  it("aprendida exige la compra de origen (23514 sin ella); con una compra del estudio entra; con la de otro estudio da 23503", async () => {
    expect(
      cod(
        await insertar("gnd_palabra_estudio", {
          origen: "aprendida",
          compra_origen_id: null,
        }),
      ),
      "aprendida sin compra",
    ).toBe("23514");
    expect(
      cod(
        await insertar("gnd_palabra_estudio", {
          origen: "aprendida",
          compra_origen_id: compraX,
        }),
      ),
      "aprendida con compra",
    ).toBe("ok");
    expect(
      cod(
        await insertar("gnd_palabra_estudio", {
          origen: "aprendida",
          compra_origen_id: compraY,
        }),
      ),
      "compra de otro estudio",
    ).toBe("23503");
  });

  it("unica (estudio, palabra): repetir da 23505; autor inexistente da 23503", async () => {
    expect(
      cod(await insertar("gnd_palabra_estudio", { palabra: "audifono" })),
    ).toBe("23505");
    expect(
      cod(
        await insertar("gnd_palabra_estudio", {
          creado_por: "00000000-0000-4000-8000-000000000003",
        }),
      ),
    ).toBe("23503");
  });
});

describe("0069 · gnd_global_desactivada, gnd_config, gnd_cliente_categorias y gnd_ciiu", () => {
  it("gnd_global_desactivada: entra una valida; repetir (estudio, global) da 23505; global o usuario inexistentes dan 23503", async () => {
    expect(cod(await insertar("gnd_global_desactivada"))).toBe("ok");
    expect(
      cod(await insertar("gnd_global_desactivada", { tenant_id: X })),
      "ya desactivada en X",
    ).toBe("23505");
    expect(
      cod(
        await insertar("gnd_global_desactivada", {
          palabra_global_id: "00000000-0000-4000-8000-000000000004",
        }),
      ),
    ).toBe("23503");
    expect(
      cod(
        await insertar("gnd_global_desactivada", {
          usuario_id: "00000000-0000-4000-8000-000000000005",
        }),
      ),
    ).toBe("23503");
  });

  it("gnd_config: umbral de 1 a 20; 0, 21 y negativo dan 23514; una fila por estudio (23505)", async () => {
    for (const u of [1, 3, 20])
      expect(cod(await insertar("gnd_config", { umbral: u })), String(u)).toBe(
        "ok",
      );
    for (const u of [0, 21, -1, 100])
      expect(cod(await insertar("gnd_config", { umbral: u })), String(u)).toBe(
        "23514",
      );
    expect(cod(await insertar("gnd_config", { tenant_id: X }))).toBe("23505");
  });

  it("gnd_cliente_categorias: subconjunto de las 6 y disjuntas; vacias entran; version 1 o mas", async () => {
    expect(cod(await insertar("gnd_cliente_categorias"))).toBe("ok");
    expect(
      cod(
        await insertar("gnd_cliente_categorias", {
          permitidas: [],
          quitadas: [],
        }),
      ),
      "vacias",
    ).toBe("ok");
    expect(
      cod(
        await insertar("gnd_cliente_categorias", {
          permitidas: [...CATEGORIAS],
          quitadas: [],
        }),
      ),
      "las 6 permitidas",
    ).toBe("ok");
    expect(
      cod(
        await insertar("gnd_cliente_categorias", {
          permitidas: ["otra"],
          quitadas: [],
        }),
      ),
      "permitida fuera de las 6",
    ).toBe("23514");
    expect(
      cod(
        await insertar("gnd_cliente_categorias", {
          permitidas: [],
          quitadas: ["Juguetes"],
        }),
      ),
      "quitada fuera de las 6",
    ).toBe("23514");
    expect(
      cod(
        await insertar("gnd_cliente_categorias", {
          permitidas: ["juguetes", "calzado-ropa"],
          quitadas: ["calzado-ropa"],
        }),
      ),
      "no disjuntas",
    ).toBe("23514");
    for (const v of [0, -1])
      expect(
        cod(await insertar("gnd_cliente_categorias", { version: v })),
        String(v),
      ).toBe("23514");
  });

  it("gnd_cliente_categorias: una fila por cliente (23505); cliente de otro estudio o inexistente da 23503", async () => {
    expect(
      cod(await insertar("gnd_cliente_categorias", { cliente_id: cx.id })),
      "ya sembrada",
    ).toBe("23505");
    expect(
      cod(await insertar("gnd_cliente_categorias", { cliente_id: cy.id })),
      "cliente de Y con tenant X",
    ).toBe("23503");
    expect(
      cod(
        await insertar("gnd_cliente_categorias", {
          cliente_id: "00000000-0000-4000-8000-000000000006",
        }),
      ),
      "inexistente",
    ).toBe("23503");
  });

  it("gnd_ciiu: RUC de 11 digitos y CIIU de 4 digitos o nulo; el resto da 23514 (o 22001 si sobra); una fila por (estudio, RUC)", async () => {
    expect(cod(await insertar("gnd_ciiu"))).toBe("ok");
    expect(cod(await insertar("gnd_ciiu", { ciiu: null })), "sin dato").toBe(
      "ok",
    );
    for (const r of ["1234567890", "2070000000a", "abcdefghijk", ""])
      expect(cod(await insertar("gnd_ciiu", { ruc: r })), r).toBe("23514");
    expect(cod(await insertar("gnd_ciiu", { ruc: "123456789012" }))).toBe(
      "22001",
    );
    for (const c of ["475", "47a2", "abcd"])
      expect(cod(await insertar("gnd_ciiu", { ciiu: c })), c).toBe("23514");
    expect(cod(await insertar("gnd_ciiu", { ciiu: "47521" }))).toBe("22001");
    expect(
      cod(await insertar("gnd_ciiu", { tenant_id: X, ruc: "20100070970" })),
      "ya en X",
    ).toBe("23505");
    expect(
      cod(await insertar("gnd_ciiu", { tenant_id: Z, ruc: "20100070970" })),
      "mismo RUC en otro estudio",
    ).toBe("ok");
  });
});

// =================================================================================================
describe("0069 · semilla del diccionario global (plan: Semilla; R-4, CA-4)", () => {
  type FilaSemilla = {
    palabra: string;
    categoria: string;
    excepciones: string[];
    activa: boolean;
    version: number;
  };
  const planas = Object.entries(SEMILLA).flatMap(([categoria, ps]) =>
    Object.entries(ps).map(([palabra, excepciones]) => ({
      palabra,
      categoria,
      excepciones,
    })),
  );

  it("son 72 palabras en las 6 categorias (la constante de la prueba coincide con el plan)", () => {
    expect(planas).toHaveLength(72);
    expect(Object.keys(SEMILLA).sort()).toEqual([...CATEGORIAS].sort());
  });

  it("cada palabra del plan esta presente, activa, version 1, con su categoria y sus excepciones (sin tildes ni mayusculas)", async () => {
    const r = (
      await admin.query(
        "select palabra, categoria, excepciones, activa, version from gnd_palabra_global where palabra = any($1::text[])",
        [planas.map((p) => p.palabra)],
      )
    ).rows as FilaSemilla[];
    expect(r, "falta la semilla (migracion 0069)").toHaveLength(72);
    const por = new Map(r.map((f) => [f.palabra, f]));
    for (const p of planas) {
      const f = por.get(p.palabra)!;
      expect(f, p.palabra).toBeDefined();
      expect(f.categoria, p.palabra).toBe(p.categoria);
      expect([...f.excepciones].sort(), `${p.palabra}: excepciones`).toEqual(
        [...p.excepciones].sort(),
      );
      expect([f.activa, f.version], p.palabra).toEqual([true, 1]);
      expect(f.palabra).toMatch(/^[a-z0-9]{3,40}$/);
    }
  });

  it("los casos del plan: zapatilla y zapato (seguridad; punta de acero), polo (a tierra), bota con jebe, mochila (fumigadora)", async () => {
    const r = await admin.query(
      "select palabra, excepciones from gnd_palabra_global where palabra = any($1::text[])",
      [["zapatilla", "zapato", "polo", "bota", "mochila"]],
    );
    const por = Object.fromEntries(
      r.rows.map((f) => [f.palabra, [...f.excepciones].sort()]),
    );
    expect(por).toEqual({
      zapatilla: ["punta de acero", "seguridad"],
      zapato: ["punta de acero", "seguridad"],
      polo: ["a tierra"],
      bota: ["jebe", "punta de acero", "seguridad"],
      mochila: ["fumigadora"],
    });
  });

  it("ninguna palabra de la semilla esta repetida (unica) y el backend y el worker la leen sin withTenant", async () => {
    const r = await admin.query(
      "select palabra, count(*)::int as n from gnd_palabra_global group by palabra having count(*) > 1",
    );
    expect(r.rows).toEqual([]);
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      const filas = await filasRaw(
        app,
        rol,
        "select palabra from gnd_palabra_global where palabra = 'zapatilla'",
      );
      expect(filas, rol).toEqual([{ palabra: "zapatilla" }]);
    }
  });
});

// =================================================================================================
describe("0069 · aislamiento entre estudios y entre clientes (CA-7, R-6)", () => {
  const FILAS: [string, string][] = [
    ["gnd_palabra_estudio", "palabra"],
    ["gnd_global_desactivada", "palabra_global_id"],
    ["gnd_config", "tenant_id"],
    ["gnd_cliente_categorias", "cliente_id"],
    ["gnd_ciiu", "ruc"],
  ];

  it("backend y worker de cada estudio ven solo las filas de su estudio, ni por columna clave del otro", async () => {
    for (const [tabla] of FILAS) {
      for (const db of [backend, worker]) {
        const x = await db.withTenant({ tenantId: X, userId: ux }, (tx) =>
          tx.query(`select tenant_id from ${tabla}`),
        );
        expect(x.rows.length, `${tabla}: vacia o sin RLS`).toBeGreaterThan(0);
        expect(new Set(x.rows.map((f) => f.tenant_id)), tabla).toEqual(
          new Set([X]),
        );
        const y = await db.withTenant({ tenantId: Y, userId: uy }, (tx) =>
          tx.query(`select tenant_id from ${tabla}`),
        );
        expect(new Set(y.rows.map((f) => f.tenant_id)), tabla).toEqual(
          new Set([Y]),
        );
      }
    }
    const porId = await backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
      tx.query("select 1 from gnd_palabra_estudio where id = $1", [palY]),
    );
    expect(porId.rowCount, "palabra de Y por id desde X").toBe(0);
    const propia = await backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
      tx.query("select 1 from gnd_palabra_estudio where id = $1", [palX]),
    );
    expect(propia.rowCount).toBe(1);
  });

  it("sin withTenant el backend y el worker ven 0 filas de las cinco del estudio", async () => {
    for (const t of TABLAS_GND_ESTUDIO)
      for (const rol of ["contapp_backend", "contapp_worker"])
        expect(
          await filasRaw(app, rol, `select 1 from ${t}`),
          `${rol} sin contexto: ${t}`,
        ).toEqual([]);
  });

  it("las filas del cliente A no aparecen al pedir por el cliente B del mismo estudio", async () => {
    const sinFilas = await eg.cliente(X);
    const propias = await backend.withTenant(
      { tenantId: X, userId: ux },
      (tx) =>
        tx.query("select 1 from gnd_cliente_categorias where cliente_id = $1", [
          cx.id,
        ]),
    );
    expect(propias.rowCount).toBe(1);
    const ajenas = await backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
      tx.query("select 1 from gnd_cliente_categorias where cliente_id = $1", [
        sinFilas.id,
      ]),
    );
    expect(ajenas.rowCount).toBe(0);
  });

  it("las dos de plataforma las lee cualquier estudio, con o sin withTenant (no tienen tenant_id)", async () => {
    for (const t of TABLAS_GND_PLATAFORMA) {
      const x = await backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
        tx.query(`select count(*)::int as n from ${t}`),
      );
      const y = await worker.withTenant({ tenantId: Y }, (tx) =>
        tx.query(`select count(*)::int as n from ${t}`),
      );
      expect(x.rows[0].n, t).toBeGreaterThan(0);
      expect(y.rows[0].n, t).toBe(x.rows[0].n);
      const s = await intentarRaw(app, "contapp_backend", `select 1 from ${t}`);
      expect(s.ok, `${t} sin contexto`).toBe(true);
    }
  });
});

// =================================================================================================
describe("0069 · CHECK de acciones de auditoria (D-4)", () => {
  it("auditoria_accion_valida admite las ocho acciones de 027 y sigue rechazando las ajenas (23514)", async () => {
    const ins = (accion: string) =>
      enRevertida(admin, async (c) => {
        await c.query(
          `insert into auditoria (tenant_id, actor_tipo, usuario_id, accion, cliente_id, entidad, entidad_id, datos)
           values ($1, 'usuario', $2, $3, $4, 'gnd_palabra_estudio', $5, '{}'::jsonb)`,
          [X, ux, accion, cx.id, palX],
        );
      });
    expect(ACCIONES_GND).toHaveLength(8);
    for (const a of [
      ...ACCIONES_GND,
      "regla.creada",
      "prorrata.usada_guardada",
    ])
      expect((await ins(a)).ok, a).toBe(true);
    for (const a of [
      "gnd.palabra",
      "gnd.umbral",
      "gnd.palabra_editada",
      "gnd.categorias",
    ]) {
      const mala = await ins(a);
      expect(mala.ok ? "ok" : mala.code, a).toBe("23514");
    }
  });
});
