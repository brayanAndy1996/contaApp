// Spec 021 (T3, rojo): tablas de las migraciones 0047 (`regla_aprendida`, `estudio_regla_motor`, `estudio_reglas_config`), 0048
// (`regla_aplicacion`) y 0049 (`regla_aceptacion`, `regla_confirmacion`) contra la BD real. Cubre D-2, D-3, D-8, CA-5, CA-6 y
// P-9/P-10 en lo que toca al catalogo: columnas, RLS FORCE, grants (sin DELETE; el worker sin escritura directa sobre `regla_*`;
// nadie de la app lee `regla_confirmacion`), CHECK, FK compuestas, unica parcial con baja logica y aislamiento entre estudios y entre
// clientes. Hasta T9 fallan por tabla inexistente. No repite lo de `compras-xml-tablas.spec.ts` (016): sigue su modelo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import {
  abrirPool,
  filasRaw,
  intentar,
  intentarRaw,
  type ContappDb,
} from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  CODIGOS_MOTOR,
  EscenarioReglas,
  ROLES_APP,
  TABLAS_REGLAS,
} from "./reglas-soporte";

let admin: Pool;
let app: Pool;
let ec: EscenarioReglas;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  ec = new EscenarioReglas(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cx2 = await ec.cliente(X);
  cy = await ec.clienteConRuc(Y, cx.ruc); // dos clientes de estudios distintos con el mismo RUC (CA-5)
  ux = await ec.usuarioDe(X);
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((p) => p?.catch(() => undefined)),
  );
  await app?.end();
  await admin?.end();
});

const columnasDe = async (tabla: string) =>
  (
    await admin.query(
      `select column_name, data_type, character_maximum_length as largo, is_nullable, column_default as defecto
         from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [tabla],
    )
  ).rows as {
    column_name: string;
    data_type: string;
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
const columnasConPrivilegio = async (
  rol: string,
  tabla: string,
  priv: string,
) =>
  (
    await admin.query(
      `select a.attname::text as c from pg_attribute a
        where a.attrelid = $2::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege($1::name, $2::regclass, a.attnum, $3::text)
        order by a.attname`,
      [rol, `public.${tabla}`, priv],
    )
  ).rows.map((x) => x.c as string);
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
const unicas = async (tabla: string) =>
  (
    await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas,
              i.indisprimary as pk, pg_get_expr(i.indpred, i.indrelid) as predicado
         from pg_index i where i.indrelid = to_regclass($1) and i.indisunique`,
      [`public.${tabla}`],
    )
  ).rows as { columnas: string[]; pk: boolean; predicado: string | null }[];

// =================================================================================================
describe("0047-0049 · columnas y tipos (plan: Contratos · BD)", () => {
  const ESPERADAS: Record<string, string[]> = {
    regla_aprendida: [
      "id",
      "tenant_id",
      "cliente_id",
      "doc_tipo",
      "doc_numero",
      "destino",
      "activa",
      "version",
      "periodo_aprendido",
      "creada_por",
      "creada_en",
      "actualizada_por",
      "actualizada_en",
      "eliminada_en",
      "eliminada_por",
    ],
    estudio_regla_motor: [
      "tenant_id",
      "codigo",
      "activa",
      "actualizada_por",
      "actualizada_en",
    ],
    estudio_reglas_config: ["tenant_id", "aportar_catalogo"],
    regla_aplicacion: [
      "id",
      "tenant_id",
      "regla_id",
      "compra_id",
      "version_n",
      "periodo",
      "creada_en",
    ],
    regla_aceptacion: [
      "tenant_id",
      "regla_aplicacion_id",
      "regla_id",
      "periodo",
      "creada_en",
    ],
    regla_confirmacion: [
      "id",
      "tenant_id",
      "regla_id",
      "cliente_id",
      "ruc_proveedor",
      "destino",
      "origen",
      "creada_en",
    ],
  };
  for (const [tabla, esperadas] of Object.entries(ESPERADAS)) {
    it(`${tabla}: tiene todas las columnas del plan`, async () => {
      const nombres = (await columnasDe(tabla)).map((c) => c.column_name);
      expect(nombres, `falta la tabla ${tabla} (migracion 0047-0049)`).not.toHaveLength(0);
      expect(nombres).toEqual(expect.arrayContaining(esperadas));
    });
  }

  it("ninguna columna de las tablas nuevas termina en _at (013 usa _en)", async () => {
    const r = await admin.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name = any($1::text[])`,
      [[...TABLAS_REGLAS]],
    );
    expect(new Set(r.rows.map((x) => x.table_name)), "faltan tablas").toEqual(
      new Set(TABLAS_REGLAS),
    );
    expect(r.rows.filter((x) => /_at$/.test(x.column_name))).toEqual([]);
  });

  it("regla_aprendida: version entero NOT NULL, periodo_aprendido char(6) NOT NULL, activa boolean NOT NULL, eliminada_en nula", async () => {
    const c = Object.fromEntries(
      (await columnasDe("regla_aprendida")).map((x) => [x.column_name, x]),
    );
    expect(Object.keys(c), "falta regla_aprendida").not.toHaveLength(0);
    expect([c.version?.data_type, c.version?.is_nullable]).toEqual([
      "integer",
      "NO",
    ]);
    expect([
      c.periodo_aprendido?.data_type,
      c.periodo_aprendido?.largo,
      c.periodo_aprendido?.is_nullable,
    ]).toEqual(["character", 6, "NO"]);
    expect([c.activa?.data_type, c.activa?.is_nullable]).toEqual([
      "boolean",
      "NO",
    ]);
    for (const k of ["destino", "doc_tipo", "doc_numero", "cliente_id"])
      expect(c[k]?.is_nullable, k).toBe("NO");
    expect([c.eliminada_en?.is_nullable, c.eliminada_por?.is_nullable]).toEqual([
      "YES",
      "YES",
    ]);
  });

  it("estudio_reglas_config.aportar_catalogo: boolean NOT NULL con defecto true (sin fila o por defecto, el aporte esta encendido)", async () => {
    const c = (await columnasDe("estudio_reglas_config")).find(
      (x) => x.column_name === "aportar_catalogo",
    );
    expect(c, "falta estudio_reglas_config").toBeDefined();
    expect([c!.data_type, c!.is_nullable, c!.defecto]).toEqual([
      "boolean",
      "NO",
      "true",
    ]);
  });

  it("claves: id con uuid_v7 por defecto; PK de estudio_regla_motor (tenant_id, codigo) y de estudio_reglas_config (tenant_id)", async () => {
    for (const t of ["regla_aprendida", "regla_aplicacion", "regla_confirmacion"]) {
      const id = (await columnasDe(t)).find((c) => c.column_name === "id");
      expect(id, `falta ${t}`).toBeDefined();
      expect(id!.defecto).toMatch(/uuid_v7\(\)/);
    }
    expect(
      (await unicas("estudio_regla_motor")).filter((u) => u.pk).map((u) => u.columnas),
      "falta estudio_regla_motor",
    ).toEqual([["tenant_id", "codigo"]]);
    expect(
      (await unicas("estudio_reglas_config")).filter((u) => u.pk).map((u) => u.columnas),
      "falta estudio_reglas_config",
    ).toEqual([["tenant_id"]]);
  });

  it("regla_aplicacion: unica (tenant_id, compra_id, version_n) (D-8: una aplicacion por version)", async () => {
    const u = (await unicas("regla_aplicacion")).map((x) => x.columnas);
    expect(u, "falta regla_aplicacion").toContainEqual([
      "tenant_id",
      "compra_id",
      "version_n",
    ]);
  });

  it("regla_aceptacion: la clave primaria incluye regla_aplicacion_id (una aceptacion por aplicacion)", async () => {
    const pk = (await unicas("regla_aceptacion")).filter((u) => u.pk);
    expect(pk, "falta regla_aceptacion").toHaveLength(1);
    expect(pk[0]!.columnas).toContain("regla_aplicacion_id");
  });
});

// =================================================================================================
describe("0047-0049 · FK compuestas (tenant_id, ...) a cliente, regla, compra_version", () => {
  const ESPERADAS: [string, string, string[]][] = [
    ["regla_aprendida", "cliente", ["tenant_id", "cliente_id"]],
    ["regla_aplicacion", "regla_aprendida", ["tenant_id", "regla_id"]],
    ["regla_aplicacion", "compra_version", ["tenant_id", "compra_id", "version_n"]],
    ["regla_aceptacion", "regla_aplicacion", ["tenant_id", "regla_aplicacion_id"]],
    ["regla_aceptacion", "regla_aprendida", ["tenant_id", "regla_id"]],
    ["regla_confirmacion", "regla_aprendida", ["tenant_id", "regla_id"]],
    ["regla_confirmacion", "cliente", ["tenant_id", "cliente_id"]],
  ];
  for (const [tabla, destino, columnas] of ESPERADAS) {
    it(`${tabla} -> ${destino} por (${columnas.join(", ")})`, async () => {
      const f = await fks(tabla);
      expect(f, `falta la tabla ${tabla}`).not.toHaveLength(0);
      expect(
        f.some((x) => x.destino.endsWith(destino) && x.columnas.join() === columnas.join()),
        `FK ${tabla} -> ${destino}: ${JSON.stringify(f)}`,
      ).toBe(true);
    });
  }
});

// =================================================================================================
describe("0047-0049 · RLS ENABLE + FORCE y catalogo de 002 (CA-5)", () => {
  for (const tabla of TABLAS_REGLAS) {
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

    it(`${tabla}: tenant_id uuid NOT NULL (el catalogo de 002 la recorre)`, async () => {
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
describe("0047-0049 · grants (plan: Contratos · BD)", () => {
  it("regla_aprendida: el backend lee e inserta; UPDATE solo de destino, activa, version, periodo_aprendido, actualizada_* y eliminada_*; nunca DELETE ni TRUNCATE", async () => {
    expect(await privilegio("contapp_backend", "regla_aprendida", "SELECT")).toBe(true);
    expect(await privilegio("contapp_backend", "regla_aprendida", "INSERT")).toBe(true);
    for (const p of ["DELETE", "TRUNCATE"])
      expect(await privilegio("contapp_backend", "regla_aprendida", p), p).toBe(false);
    expect(await columnasConPrivilegio("contapp_backend", "regla_aprendida", "UPDATE")).toEqual(
      [
        "activa",
        "actualizada_en",
        "actualizada_por",
        "destino",
        "eliminada_en",
        "eliminada_por",
        "periodo_aprendido",
        "version",
      ],
    );
  });

  it("regla_aprendida: el worker no tiene ningun grant directo (lee por reglas_historial_vigentes)", async () => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      expect(await privilegio("contapp_worker", "regla_aprendida", p), `worker ${p}`).toBe(false);
    }
    for (const p of ["SELECT", "INSERT", "UPDATE"]) {
      expect(await algunaColumna("contapp_worker", "regla_aprendida", p), `worker col ${p}`).toBe(false);
    }
  });

  for (const tabla of ["estudio_regla_motor", "estudio_reglas_config"] as const) {
    it(`${tabla}: SELECT a backend y worker; INSERT y UPDATE solo al backend; nunca DELETE`, async () => {
      expect(await privilegio("contapp_backend", tabla, "SELECT")).toBe(true);
      expect(await privilegio("contapp_worker", tabla, "SELECT")).toBe(true);
      expect(await privilegio("contapp_backend", tabla, "INSERT")).toBe(true);
      expect(await algunaColumna("contapp_backend", tabla, "UPDATE")).toBe(true);
      for (const p of ["INSERT", "UPDATE"]) {
        expect(await privilegio("contapp_worker", tabla, p), `worker ${p}`).toBe(false);
        expect(await algunaColumna("contapp_worker", tabla, p), `worker col ${p}`).toBe(false);
      }
      for (const rol of ["contapp_backend", "contapp_worker"]) {
        expect(await privilegio(rol, tabla, "DELETE"), `${rol} DELETE`).toBe(false);
        expect(await privilegio(rol, tabla, "TRUNCATE"), `${rol} TRUNCATE`).toBe(false);
      }
    });
  }

  for (const tabla of ["regla_aplicacion", "regla_aceptacion"] as const) {
    it(`${tabla}: solo insercion y sin grants de escritura para ningun rol de la app; el backend la lee (contadores de CA-7)`, async () => {
      expect(await privilegio("contapp_backend", tabla, "SELECT"), "backend SELECT").toBe(true);
      for (const rol of ROLES_APP) {
        for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect(await privilegio(rol, tabla, p), `${rol} ${p} ${tabla}`).toBe(false);
        }
        expect(await algunaColumna(rol, tabla, "INSERT"), `${rol} col INSERT`).toBe(false);
        expect(await algunaColumna(rol, tabla, "UPDATE"), `${rol} col UPDATE`).toBe(false);
      }
    });
  }

  it("regla_confirmacion: nadie de la app la lee; INSERT solo al backend; sin UPDATE, DELETE ni TRUNCATE (D-3, CA-6)", async () => {
    for (const rol of ROLES_APP) {
      expect(await privilegio(rol, "regla_confirmacion", "SELECT"), `${rol} SELECT`).toBe(false);
      expect(await algunaColumna(rol, "regla_confirmacion", "SELECT"), `${rol} col SELECT`).toBe(false);
      for (const p of ["UPDATE", "DELETE", "TRUNCATE"]) {
        expect(await privilegio(rol, "regla_confirmacion", p), `${rol} ${p}`).toBe(false);
      }
      expect(await algunaColumna(rol, "regla_confirmacion", "UPDATE"), `${rol} col UPDATE`).toBe(false);
      expect(await privilegio(rol, "regla_confirmacion", "INSERT"), `${rol} INSERT`).toBe(
        rol === "contapp_backend",
      );
    }
  });

  it("regla_confirmacion: ningun rol de la app puede leerla, ni la de su propio estudio ni la de otro (consulta directa, 42501)", async () => {
    const regla = await ec.regla(X, cx, { docNumero: "20555000111" });
    await admin.query(
      `insert into regla_confirmacion (tenant_id, regla_id, cliente_id, ruc_proveedor, destino, origen)
       values ($1, $2, $3, '20555000111', 'DNG', 'recordar')`,
      [X, regla, cx.id],
    );
    for (const [db, rol] of [
      [backend, "contapp_backend"],
      [worker, "contapp_worker"],
    ] as const) {
      expect(
        codigo(await intentar(db, { tenantId: X }, "select * from regla_confirmacion")),
        `${rol} estudio propio`,
      ).toBe("42501");
      expect(
        codigo(await intentar(db, { tenantId: Y }, "select count(*) from regla_confirmacion")),
        `${rol} estudio ajeno`,
      ).toBe("42501");
    }
  });
});

// =================================================================================================
describe("0047-0049 · CHECK (destino, version, codigo, origen)", () => {
  const insertarRegla = (destino: string, version: number, periodo: string) =>
    intentar(
      backend,
      { tenantId: X, userId: ux },
      `insert into regla_aprendida (cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por)
       values ($1, '6', '20100070999', $2, true, $3, $4, $5, $5)`,
      [cx2.id, destino, version, periodo, ux],
    );

  it("regla_aprendida acepta DG, DGNG y DNG (la prueba no es vacua)", async () => {
    for (const d of ["DG", "DGNG", "DNG"])
      expect(codigo(await insertarRegla(d, 1, "202609")), d).toBe("ok");
  });

  it("regla_aprendida rechaza un destino fuera de DG|DGNG|DNG y version < 1 (23514)", async () => {
    expect(codigo(await insertarRegla("XX", 1, "202609"))).toBe("23514");
    expect(codigo(await insertarRegla("dng", 1, "202609"))).toBe("23514");
    expect(codigo(await insertarRegla("DNG", 0, "202609"))).toBe("23514");
  });

  it("estudio_regla_motor: acepta R-ISC, R-MIX, R-RED, R-NEW, R-GP y R-HIS; rechaza otro codigo, tambien la prevalidacion (P-8)", async () => {
    for (const c of CODIGOS_MOTOR) {
      expect(
        codigo(
          await intentar(
            backend,
            { tenantId: X, userId: ux },
            "insert into estudio_regla_motor (codigo, activa, actualizada_por) values ($1, false, $2)",
            [c, ux],
          ),
        ),
        c,
      ).toBe("ok");
    }
    for (const c of ["R-XXX", "PREVALIDACION", "r-his", ""]) {
      expect(
        codigo(
          await intentar(
            backend,
            { tenantId: X, userId: ux },
            "insert into estudio_regla_motor (codigo, activa, actualizada_por) values ($1, false, $2)",
            [c, ux],
          ),
        ),
        `codigo ${JSON.stringify(c)}`,
      ).toBe("23514");
    }
  });

  it("regla_confirmacion: origen solo recordar|aceptada (23514)", async () => {
    const regla = await ec.regla(X, cx2, { docNumero: "20100070888" });
    const ins = (origen: string, destino: string) =>
      intentar(
        backend,
        { tenantId: X, userId: ux },
        `insert into regla_confirmacion (regla_id, cliente_id, ruc_proveedor, destino, origen)
         values ($1, $2, '20100070888', $3, $4)`,
        [regla, cx2.id, destino, origen],
      );
    expect(codigo(await ins("recordar", "DNG"))).toBe("ok");
    expect(codigo(await ins("aceptada", "DG"))).toBe("ok");
    expect(codigo(await ins("manual", "DNG"))).toBe("23514");
  });
});

// =================================================================================================
describe("0047 · unica parcial con baja logica (P-9)", () => {
  const crear = (cliente: string, docNumero: string, tenant = X, db = backend) =>
    intentar(
      db,
      { tenantId: tenant, userId: ux },
      `insert into regla_aprendida (cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por)
       values ($1, '6', $2, 'DNG', true, 1, '202609', $3, $3)`,
      [cliente, docNumero, ux],
    );

  it("la unica es (tenant_id, cliente_id, doc_tipo, doc_numero) WHERE eliminada_en IS NULL", async () => {
    const u = (await unicas("regla_aprendida")).find(
      (x) =>
        x.columnas.join() === "tenant_id,cliente_id,doc_tipo,doc_numero" && !x.pk,
    );
    expect(u, "falta la unica parcial de regla_aprendida").toBeDefined();
    expect(u!.predicado).toMatch(/eliminada_en IS NULL/i);
  });

  it("una segunda regla viva del mismo cliente y proveedor da 23505, aunque este inactiva", async () => {
    await ec.regla(X, cx, { docNumero: "20111111111", activa: false });
    expect(codigo(await crear(cx.id, "20111111111"))).toBe("23505");
  });

  it("el mismo proveedor en otro cliente del mismo estudio, otro documento y otro estudio se admiten", async () => {
    await ec.regla(X, cx, { docNumero: "20222222222" });
    expect(codigo(await crear(cx2.id, "20222222222")), "otro cliente").toBe("ok");
    expect(codigo(await crear(cx.id, "20222222223")), "otro documento").toBe("ok");
    expect(
      codigo(await crear(cy.id, "20222222222", Y)),
      "otro estudio (mismo RUC de cliente, mismo proveedor)",
    ).toBe("ok");
  });

  it("eliminar (baja logica) y volver a crear funciona; la eliminada conserva su fila", async () => {
    const id = await ec.regla(X, cx, { docNumero: "20333333333" });
    // La baja la hace el backend de verdad (con commit): UPDATE de eliminada_en, eliminada_por y version.
    await backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
      tx.query(
        "update regla_aprendida set eliminada_en = now(), eliminada_por = $2, version = version + 1 where id = $1",
        [id, ux],
      ),
    );
    const alta = await backend.withTenant({ tenantId: X, userId: ux }, async (tx) => {
      await tx.query(
        `insert into regla_aprendida (cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por)
         values ($1, '6', '20333333333', 'DNG', true, 1, '202609', $2, $2)`,
        [cx.id, ux],
      );
      return "ok";
    });
    expect(alta, "alta tras la baja").toBe("ok");
    const filas = await admin.query(
      "select count(*)::int as n, count(*) filter (where eliminada_en is null)::int as vivas from regla_aprendida where cliente_id = $1 and doc_numero = '20333333333'",
      [cx.id],
    );
    expect(filas.rows[0]).toEqual({ n: 2, vivas: 1 });
    const baja = (await admin.query("select eliminada_en, eliminada_por from regla_aprendida where id = $1", [id])).rows[0];
    expect(baja.eliminada_en).not.toBeNull();
    expect(baja.eliminada_por).toBe(ux);
  });

  it("el backend no puede borrar (DELETE, 42501) ni cambiar la identidad de la regla (cliente_id, doc_numero: 42501)", async () => {
    const id = await ec.regla(X, cx, { docNumero: "20444444444" });
    expect(
      codigo(await intentar(backend, { tenantId: X, userId: ux }, "delete from regla_aprendida where id = $1", [id])),
    ).toBe("42501");
    for (const [set, extra] of [
      ["cliente_id = $2", [cx2.id]],
      ["doc_numero = '20000000000'", []],
      ["doc_tipo = '1'", []],
      ["creada_por = $2", [ux]],
    ] as const) {
      expect(
        codigo(
          await intentar(backend, { tenantId: X, userId: ux }, `update regla_aprendida set ${set} where id = $1`, [id, ...extra]),
        ),
        set,
      ).toBe("42501");
    }
  });
});

// =================================================================================================
describe("0047-0049 · aislamiento entre estudios y entre clientes (CA-5, D-2, RF-115)", () => {
  it("dos estudios con clientes del mismo RUC y la misma regla: cada uno ve solo la suya; sin withTenant no se ve nada", async () => {
    expect(cy.ruc).toBe(cx.ruc);
    const rx = await ec.regla(X, cx, { docNumero: "20999000001", destino: "DNG" });
    const ry = await ec.regla(Y, cy, { docNumero: "20999000001", destino: "DG" });
    for (const [db, tenant, propia, ajena] of [
      [backend, X, rx, ry],
      [backend, Y, ry, rx],
    ] as const) {
      const r = await db.withTenant({ tenantId: tenant }, (tx) =>
        tx.query("select id from regla_aprendida where doc_numero = '20999000001'"),
      );
      expect(r.rows.map((x) => x.id), "tabla vacia o sin RLS").toEqual([propia]);
      const ajenaPorId = await db.withTenant({ tenantId: tenant }, (tx) =>
        tx.query("select 1 from regla_aprendida where id = $1", [ajena]),
      );
      expect(ajenaPorId.rowCount).toBe(0);
    }
    expect(await filasRaw(app, "contapp_backend", "select 1 from regla_aprendida"), "backend sin withTenant").toEqual([]);
    const w = await intentarRaw(app, "contapp_worker", "select 1 from regla_aprendida");
    // El worker no tiene SELECT directo: o falla por permiso o ve 0 filas; en ningun caso ve filas.
    if (w.ok) expect(w.rowCount, "worker sin withTenant").toBe(0);
  });

  it("estudio_regla_motor y estudio_reglas_config: un estudio no ve los interruptores del otro; sin withTenant, nada", async () => {
    await ec.interruptor(X, "R-HIS", false);
    await ec.aporte(X, false);
    await ec.interruptor(Y, "R-GP", false);
    for (const tabla of ["estudio_regla_motor", "estudio_reglas_config"]) {
      const y = await backend.withTenant({ tenantId: Y }, (tx) =>
        tx.query(`select tenant_id from ${tabla}`),
      );
      expect(y.rows.every((f) => f.tenant_id === Y), `${tabla}: filas ajenas`).toBe(true);
      expect(await filasRaw(app, "contapp_backend", `select 1 from ${tabla}`), `${tabla} sin contexto`).toEqual([]);
      const x = await backend.withTenant({ tenantId: X }, (tx) =>
        tx.query(`select tenant_id from ${tabla}`),
      );
      expect(x.rowCount, `${tabla}: el propio estudio ve la suya`).toBeGreaterThan(0);
    }
  });

  it("no se inserta una regla con el tenant_id de otro estudio (42501) ni para un cliente ajeno (23503)", async () => {
    const otroTenant = await intentar(
      backend,
      { tenantId: X, userId: ux },
      `insert into regla_aprendida (tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por)
       values ($1, $2, '6', '20777000001', 'DNG', true, 1, '202609', $3, $3)`,
      [Y, cy.id, ux],
    );
    expect(codigo(otroTenant)).toBe("42501");
    const clienteAjeno = await intentar(
      backend,
      { tenantId: X, userId: ux },
      `insert into regla_aprendida (cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por)
       values ($1, '6', '20777000002', 'DNG', true, 1, '202609', $2, $2)`,
      [cy.id, ux],
    );
    expect(codigo(clienteAjeno), "FK compuesta (tenant_id, cliente_id)").toBe("23503");
  });

  it("una regla del cliente A no es visible para el cliente B del mismo estudio por cliente_id (la regla es por cliente, nunca por RUC de proveedor)", async () => {
    await ec.regla(X, cx, { docNumero: "20888000001" });
    const r = await backend.withTenant({ tenantId: X }, (tx) =>
      tx.query("select 1 from regla_aprendida where cliente_id = $1 and doc_numero = '20888000001'", [cx2.id]),
    );
    expect(r.rowCount).toBe(0);
  });

  it("regla_confirmacion: el backend inserta la de su estudio (sin RETURNING) y no la de otro (42501); no puede actualizarla ni borrarla", async () => {
    const regla = await ec.regla(X, cx2, { docNumero: "20666000001" });
    const sql = `insert into regla_confirmacion (tenant_id, regla_id, cliente_id, ruc_proveedor, destino, origen)
                 values ($1, $2, $3, '20666000001', 'DNG', 'recordar')`;
    expect(codigo(await intentar(backend, { tenantId: X, userId: ux }, sql, [X, regla, cx2.id]))).toBe("ok");
    expect(codigo(await intentar(backend, { tenantId: X, userId: ux }, sql, [Y, regla, cx2.id])), "tenant ajeno").toBe("42501");
    for (const s of [
      "update regla_confirmacion set destino = 'DG'",
      "delete from regla_confirmacion",
    ]) {
      expect(codigo(await intentar(backend, { tenantId: X, userId: ux }, s)), s).toBe("42501");
    }
    expect(
      codigo(await intentar(worker, { tenantId: X }, sql, [X, regla, cx2.id])),
      "el worker no inserta confirmaciones",
    ).toBe("42501");
  });
});
