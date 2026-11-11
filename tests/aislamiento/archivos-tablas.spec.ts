// Spec 012b (T4, rojo): tabla `archivo_generado` (0040) contra la BD real (CA-2, CA-5, CA-7, CA-9; D3, D5, D6; plan «Contratos: BD»).
// Cubre RLS FORCE, grants exactos, CHECK, inmutabilidad (tambien para el dueno y el superusuario), el trigger de insercion
// (periodo `generado` por el mismo usuario y version = max + 1) y el aislamiento por estudio. Hasta T10 fallan por tabla
// inexistente. El contrato completo (tablas, triggers y funciones) esta en el encabezado de `archivos-soporte.ts`.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { abrirPool, filasRaw, intentar, type ContappDb } from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  checksDe,
  columnasDe,
  fksDe,
  funcionesSinSearchPath,
  grantsColumnas,
  grantsTabla,
  rlsDe,
  triggersDe,
  unicasDe,
} from "./archivos-catalogo";
import {
  BYTES,
  contarEn,
  datosArchivo,
  EscenarioArchivos,
  HEX,
  INSERTAR_ARCHIVO,
  PERIODO,
  valoresArchivo,
  type DatosArchivo,
  type Libro,
} from "./archivos-soporte";

let admin: Pool;
let app: Pool;
let ec: EscenarioArchivos;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let ux2: string;
let uy: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  ec = new EscenarioArchivos(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  ux2 = (await ec.miembro(X, "contador")).id;
  uy = await ec.usuarioDe(Y);
  backend = crearDb("contapp_backend", 6);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((d) => d?.catch(() => undefined)),
  );
  await app?.end();
  await admin?.end();
});

/** Un cliente nuevo del estudio X (cada prueba usa el suyo para no chocar con las versiones de otra). */
const clienteNuevo = () => ec.cliente(X);

/** Inserta una version como el worker (y la CONFIRMA si entra); devuelve el SQLSTATE o 'ok'. */
async function insertarComoWorker(d: DatosArchivo, tenantId = X) {
  try {
    await worker.withTenant({ tenantId }, (tx) =>
      tx.query(INSERTAR_ARCHIVO, valoresArchivo(d)),
    );
    return "ok";
  } catch (e) {
    return String((e as { code?: string }).code ?? "sin_codigo");
  }
}

/** Sentencia como el dueno de la migracion (contapp_migrator), con el contexto del estudio, siempre con ROLLBACK. */
async function comoMigrador(sql: string, valores: unknown[], tenantId = X) {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE contapp_migrator");
    await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, valores);
    return { ok: true as const, rowCount: r.rowCount ?? 0, code: "ok" };
  } catch (e) {
    return {
      ok: false as const,
      rowCount: 0,
      code: String((e as { code?: string }).code ?? ""),
    };
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

// =================================================================================================
describe("0040 · columnas y tipos (D3)", () => {
  const COLUMNAS = [
    "id",
    "tenant_id",
    "cliente_id",
    "periodo",
    "libro",
    "version",
    "formato_id",
    "formato_version",
    "provisional",
    "nombre_txt",
    "nombre_zip",
    "sha256_txt",
    "sha256_zip",
    "bytes_zip",
    "lineas",
    "huella",
    "modificadas",
    "excluidas",
    "agregadas",
    "impacto_igv_dg",
    "impacto_igv_dgng",
    "impacto_igv_dng",
    "impacto_igv_total",
    "avisos",
    "ruta",
    "trabajo_id",
    "generado_por",
    "generado_en",
  ];

  it("tiene las 28 columnas del plan; solo los impactos por destino son opcionales", async () => {
    const cols = await columnasDe(admin, "archivo_generado");
    expect(
      cols.map((c) => c.column_name).sort(),
      "falta la tabla archivo_generado (migracion 0040)",
    ).toEqual([...COLUMNAS].sort());
    expect(
      cols
        .filter((c) => c.is_nullable === "YES")
        .map((c) => c.column_name)
        .sort(),
    ).toEqual(["impacto_igv_dg", "impacto_igv_dgng", "impacto_igv_dng"]);
  });

  it("los impactos son NUMERIC(14,2) (nunca number), los hashes bytea y los avisos jsonb", async () => {
    const por = Object.fromEntries(
      (await columnasDe(admin, "archivo_generado")).map((c) => [
        c.column_name,
        c,
      ]),
    );
    expect(Object.keys(por), "falta la tabla").not.toHaveLength(0);
    for (const c of [
      "impacto_igv_dg",
      "impacto_igv_dgng",
      "impacto_igv_dng",
      "impacto_igv_total",
    ]) {
      expect([por[c].data_type, por[c].p, por[c].s], c).toEqual([
        "numeric",
        14,
        2,
      ]);
    }
    expect(por.sha256_txt.data_type).toBe("bytea");
    expect(por.sha256_zip.data_type).toBe("bytea");
    expect(por.avisos.data_type).toBe("jsonb");
    expect(por.periodo.data_type).toBe("character");
    expect(por.provisional.data_type).toBe("boolean");
    expect(por.generado_en.data_type).toBe("timestamp with time zone");
    expect(por.id.data_type).toBe("uuid");
    expect(por.trabajo_id.data_type).toBe("uuid");
  });
});

// =================================================================================================
describe("0040 · RLS ENABLE + FORCE, dueno y grants exactos (CA-9, D3)", () => {
  it("RLS habilitada y forzada con tenant_isolation FOR ALL sobre app.tenant_id; dueno contapp_migrator", async () => {
    const { tabla, politicas } = await rlsDe(admin, "archivo_generado");
    expect(tabla, "falta la tabla archivo_generado (0040)").toBeDefined();
    expect(tabla).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      dueno: "contapp_migrator",
    });
    expect(politicas.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    expect(politicas[0].polcmd).toBe("*");
    expect(politicas[0].usando).toContain("app.tenant_id");
    expect(politicas[0].con_check).toContain("app.tenant_id");
  });

  it("grants de tabla exactos: backend solo SELECT; worker SELECT e INSERT; nadie mas (ni PUBLIC, app, platform, auth)", async () => {
    expect(await grantsTabla(admin, "archivo_generado")).toEqual({
      contapp_backend: ["SELECT"],
      contapp_worker: ["INSERT", "SELECT"],
    });
  });

  it("sin grants por columna (ni UPDATE de ninguna columna, ni para el worker)", async () => {
    expect(await grantsColumnas(admin, "archivo_generado")).toEqual({});
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      for (const p of ["UPDATE", "DELETE", "TRUNCATE"]) {
        const r = await admin.query(
          p === "UPDATE"
            ? "select has_any_column_privilege($1::name, 'public.archivo_generado'::regclass, 'UPDATE') as v"
            : "select has_table_privilege($1::name, 'public.archivo_generado'::regclass, $2::text) as v",
          p === "UPDATE" ? [rol] : [rol, p],
        );
        expect(r.rows[0].v, `${rol} ${p}`).toBe(false);
      }
    }
    const b = await admin.query(
      "select has_any_column_privilege('contapp_backend', 'public.archivo_generado'::regclass, 'INSERT') as v",
    );
    expect(b.rows[0].v, "el backend no inserta (CA-9)").toBe(false);
  });
});

// =================================================================================================
describe("0040 · llaves, unicas y triggers (catalogo)", () => {
  it("unicas (tenant, cliente, periodo, libro, version) y (tenant, trabajo_id); PK por id", async () => {
    const u = await unicasDe(admin, "archivo_generado");
    expect(u.length, "falta la tabla").toBeGreaterThan(0);
    const cols = u.map((x) => x.columnas.join(","));
    expect(cols).toContain("tenant_id,cliente_id,periodo,libro,version");
    expect(cols).toContain("tenant_id,trabajo_id");
    const pk = u.find((x) => x.pk);
    expect(pk?.columnas.includes("id")).toBe(true);
  });

  it("FK compuestas: (tenant_id, cliente_id) -> cliente y (tenant_id, generado_por) -> membresia", async () => {
    const fk = await fksDe(admin, "archivo_generado");
    const c = fk.find((f) => f.destino === "cliente");
    expect([c?.columnas, c?.destinos]).toEqual([
      ["tenant_id", "cliente_id"],
      ["tenant_id", "id"],
    ]);
    const m = fk.find(
      (f) => f.destino === "membresia" && f.columnas.includes("generado_por"),
    );
    expect([m?.columnas, m?.destinos]).toEqual([
      ["tenant_id", "generado_por"],
      ["tenant_id", "usuario_id"],
    ]);
  });

  it("triggers: uno BEFORE UPDATE OR DELETE y uno BEFORE INSERT, por fila, habilitados, de dueno contapp_migrator y con search_path fijo", async () => {
    const t = await triggersDe(admin, "archivo_generado");
    expect(t.length, "faltan los triggers de 0040").toBeGreaterThanOrEqual(2);
    expect(
      t.some((x) => x.porFila && x.antes && x.update && x.delete && !x.insert),
      "BEFORE UPDATE OR DELETE",
    ).toBe(true);
    expect(
      t.some((x) => x.porFila && x.antes && x.insert && !x.update),
      "BEFORE INSERT",
    ).toBe(true);
    for (const x of t) {
      expect(x.habilitado, x.nombre).toBe("O");
      expect(x.dueno, x.nombre).toBe("contapp_migrator");
    }
    expect(await funcionesSinSearchPath(admin, "archivo_generado")).toEqual([]);
  });

  it("los CHECK de la tabla existen (libro, periodo, version, hashes, huella, nombres, ruta, impactos, avisos)", async () => {
    const defs = (await checksDe(admin, "archivo_generado"))
      .map((c) => c.def)
      .join("\n");
    expect(defs, "falta la tabla").not.toBe("");
    for (const palabra of [
      "libro",
      "periodo",
      "version",
      "sha256_txt",
      "sha256_zip",
      "huella",
      "nombre_txt",
      "nombre_zip",
      "ruta",
      "impacto_igv_dg",
      "avisos",
    ])
      expect(defs, palabra).toContain(palabra);
  });
});

// =================================================================================================
describe("0040 · CHECK de las columnas (se siembra saltando los triggers; el rechazo es 23514)", () => {
  const base = async (o: Partial<DatosArchivo> = {}) =>
    datosArchivo(
      X,
      await clienteNuevo(),
      ux,
      await ec.trabajoArchivo(X, cx),
      o,
    );
  /** El cliente y el trabajo tienen que existir: cada caso crea los suyos. */
  const caso = async (o: (d: DatosArchivo) => Partial<DatosArchivo>) => {
    const c = await clienteNuevo();
    const t = await ec.trabajoArchivo(X, c);
    const d = datosArchivo(X, c, ux, t);
    return ec.insertarCrudo({ ...d, ...o(d) });
  };

  it("el dato base es valido (control: el resto de las pruebas falla por su columna, no por el armado)", async () => {
    expect(await ec.insertarCrudo(await base())).toBe("ok");
    const c = await clienteNuevo();
    const v = datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c), {
      libro: "ventas",
    });
    expect(await ec.insertarCrudo(v)).toBe("ok");
  });

  it.each([
    ["libro fuera de compras|ventas", { libro: "otros" as Libro }],
    ["periodo con guion", { periodo: "2026-1" }],
    ["periodo con mes 13", { periodo: "202613" }],
    ["version 0", { version: 0 }],
    ["version negativa", { version: -1 }],
    ["sha256_txt de 31 bytes", { sha256Txt: Buffer.alloc(31, 1) }],
    ["sha256_txt de 33 bytes", { sha256Txt: Buffer.alloc(33, 1) }],
    ["sha256_zip de 31 bytes", { sha256Zip: Buffer.alloc(31, 1) }],
    ["sha256_zip de 33 bytes", { sha256Zip: Buffer.alloc(33, 1) }],
    ["huella de 63 caracteres", { huella: "c".repeat(63) }],
    ["huella de 65 caracteres", { huella: "c".repeat(65) }],
    ["huella no hexadecimal", { huella: "g".repeat(64) }],
    ["huella vacia", { huella: "" }],
  ])("%s -> 23514", async (_n, cambio) => {
    expect(await caso(() => cambio as Partial<DatosArchivo>)).toBe("23514");
  });

  it.each([
    [
      "nombre_txt con ..",
      (d: DatosArchivo) => ({ nombreTxt: "../" + d.nombreTxt }),
    ],
    [
      "nombre_txt con /",
      (d: DatosArchivo) => ({ nombreTxt: "a/" + d.nombreTxt }),
    ],
    [
      "nombre_txt con \\",
      (d: DatosArchivo) => ({ nombreTxt: "a\\" + d.nombreTxt }),
    ],
    [
      "nombre_txt con espacio",
      () => ({ nombreTxt: "CONTAPP PROVISIONAL.txt" }),
    ],
    ["nombre_txt con .zip", (d: DatosArchivo) => ({ nombreTxt: d.nombreZip })],
    ["nombre_txt vacio", () => ({ nombreTxt: "" })],
    [
      "nombre_txt con salto de linea",
      (d: DatosArchivo) => ({
        nombreTxt: d.nombreTxt.replace(".txt", "\n.txt"),
      }),
    ],
    [
      "nombre_zip con ..",
      (d: DatosArchivo) => ({ nombreZip: "../" + d.nombreZip }),
    ],
    [
      "nombre_zip con /",
      (d: DatosArchivo) => ({ nombreZip: "a/" + d.nombreZip }),
    ],
    ["nombre_zip con .txt", (d: DatosArchivo) => ({ nombreZip: d.nombreTxt })],
    ["nombre_zip vacio", () => ({ nombreZip: "" })],
  ])("%s -> 23514", async (_n, cambio) => {
    expect(await caso(cambio)).toBe("23514");
  });

  it.each([
    [
      "ruta de otro id",
      (d: DatosArchivo) => ({
        ruta: d.ruta.replace(d.id, "00000000-0000-4000-8000-000000000000"),
      }),
    ],
    [
      "ruta de otro estudio",
      (d: DatosArchivo) => ({
        ruta: d.ruta.replace(
          d.tenantId,
          "00000000-0000-4000-8000-000000000000",
        ),
      }),
    ],
    [
      "ruta de otro cliente",
      (d: DatosArchivo) => ({
        ruta: d.ruta.replace(
          d.clienteId,
          "00000000-0000-4000-8000-000000000000",
        ),
      }),
    ],
    ["ruta con ..", (d: DatosArchivo) => ({ ruta: `archivos/../${d.id}.zip` })],
    [
      "ruta con extension .txt",
      (d: DatosArchivo) => ({ ruta: d.ruta.replace(/\.zip$/, ".txt") }),
    ],
    [
      "ruta de la gramatica de XML",
      (d: DatosArchivo) => ({
        ruta: `xml/${d.tenantId}/${d.clienteId}/${d.id}.xml`,
      }),
    ],
    [
      "ruta con mayusculas en el id",
      (d: DatosArchivo) => ({ ruta: d.ruta.replace(d.id, d.id.toUpperCase()) }),
    ],
    ["ruta vacia", () => ({ ruta: "" })],
  ])("%s -> 23514", async (_n, cambio) => {
    expect(await caso(cambio)).toBe("23514");
  });

  it.each([
    [
      "ventas con impacto en DG",
      {
        libro: "ventas" as Libro,
        impactoDg: "1.00",
        impactoDgng: null,
        impactoDng: null,
        nombreTxt: "CONTAPP-PROVISIONAL-20700000002-202610-RVIE.txt",
        nombreZip: "CONTAPP-PROVISIONAL-20700000002-202610-RVIE.zip",
      },
    ],
    [
      "ventas con impacto en DNG",
      {
        libro: "ventas" as Libro,
        impactoDg: null,
        impactoDgng: null,
        impactoDng: "1.00",
        nombreTxt: "CONTAPP-PROVISIONAL-20700000002-202610-RVIE.txt",
        nombreZip: "CONTAPP-PROVISIONAL-20700000002-202610-RVIE.zip",
      },
    ],
    [
      "ventas con los tres impactos",
      {
        libro: "ventas" as Libro,
        nombreTxt: "CONTAPP-PROVISIONAL-20700000002-202610-RVIE.txt",
        nombreZip: "CONTAPP-PROVISIONAL-20700000002-202610-RVIE.zip",
      },
    ],
    ["compras sin impacto en DG", { impactoDg: null }],
    ["compras sin impacto en DGNG", { impactoDgng: null }],
    ["compras sin impacto en DNG", { impactoDng: null }],
  ])(
    "impactos por destino nulos si y solo si ventas: %s -> 23514",
    async (_n, cambio) => {
      expect(await caso(() => cambio as Partial<DatosArchivo>)).toBe("23514");
    },
  );

  it("el impacto total es obligatorio y los montos no caben mas de 14 digitos (NUMERIC(14,2))", async () => {
    expect(
      await caso(() => ({ impactoTotal: null as unknown as string })),
    ).toBe("23502");
    expect(await caso(() => ({ impactoTotal: "1234567890123.45" }))).toBe(
      "22003",
    );
    expect(
      await caso(() => ({
        impactoTotal: "-9999999999.99",
        impactoDg: "-9999999999.99",
      })),
    ).toBe("ok");
  });

  it.each([
    ["avisos como arreglo", []],
    ["avisos como arreglo con datos", [{ codigo: "R-ISC" }]],
    ["avisos como cadena", "R-ISC"],
    [
      "avisos de mas de 2 KB",
      Object.fromEntries(
        Array.from({ length: 120 }, (_, i) => [`AVISO-LARGO-${i}`, 123456]),
      ),
    ],
  ])("%s -> 23514", async (_n, avisos) => {
    expect(
      await caso(() => ({ avisos: avisos as DatosArchivo["avisos"] })),
    ).toBe("23514");
  });

  it("avisos: el objeto vacio y el de conteos por codigo se aceptan", async () => {
    expect(await caso(() => ({ avisos: {} }))).toBe("ok");
    expect(
      await caso(() => ({
        avisos: { "R-ISC": 2, "R-NEW": 1, SALTO_CORRELATIVIDAD: 3 },
      })),
    ).toBe("ok");
  });

  it("unicas: la misma version (23505) y el mismo trabajo (23505) no se repiten", async () => {
    const c = await clienteNuevo();
    const a = await ec.archivo(X, c, ux, { version: 1 });
    expect(
      await ec.insertarCrudo(
        datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c), { version: 1 }),
      ),
      "misma (cliente, periodo, libro, version)",
    ).toBe("23505");
    expect(
      await ec.insertarCrudo(
        datosArchivo(X, c, ux, a.trabajoId, { version: 2 }),
      ),
      "mismo trabajo_id",
    ).toBe("23505");
    expect(
      await ec.insertarCrudo(
        datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c), {
          version: 1,
          libro: "ventas",
          impactoDg: null,
          impactoDgng: null,
          impactoDng: null,
          nombreTxt: a.nombreTxt.replace("-RCE.", "-RVIE."),
          nombreZip: a.nombreZip.replace("-RCE.", "-RVIE."),
        }),
      ),
      "otro libro, misma version: otra serie de numeracion",
    ).toBe("ok");
  });
});

// =================================================================================================
describe("0040 · inmutabilidad: nadie actualiza ni borra, tampoco el dueno ni el superusuario (D3, CA-9)", () => {
  it("el worker y el backend no actualizan ni borran (42501)", async () => {
    const c = await clienteNuevo();
    const a = await ec.archivo(X, c, ux);
    for (const db of [worker, backend]) {
      for (const sql of [
        "update archivo_generado set lineas = 99 where id = $1",
        "update archivo_generado set sha256_zip = $2 where id = $1",
        "update archivo_generado set ruta = 'archivos/x.zip' where id = $1",
        "delete from archivo_generado where id = $1",
      ]) {
        const valores = sql.includes("$2") ? [a.id, BYTES("d")] : [a.id];
        expect(
          codigo(await intentar(db, { tenantId: X }, sql, valores)),
          sql,
        ).toBe("42501");
      }
    }
    expect(
      (
        await admin.query(
          "select lineas, encode(sha256_zip, 'hex') as h from archivo_generado where id = $1",
          [a.id],
        )
      ).rows,
    ).toEqual([{ lineas: 3, h: HEX("b") }]);
  });

  it("el superusuario tampoco: el trigger responde 42501 (no es solo un grant)", async () => {
    const c = await clienteNuevo();
    const a = await ec.archivo(X, c, ux);
    for (const sql of [
      "update archivo_generado set lineas = 99 where id = $1",
      "update archivo_generado set huella = $2 where id = $1",
      "delete from archivo_generado where id = $1",
    ]) {
      const r = await admin
        .query(sql, sql.includes("$2") ? [a.id, HEX("e")] : [a.id])
        .then(() => "ok")
        .catch((e: { code?: string }) => String(e.code));
      expect(r, sql).toBe("42501");
    }
    expect(
      await contarEn(admin, "archivo_generado", "id = $1 and lineas = 3", [
        a.id,
      ]),
    ).toBe(1);
  });

  it("el dueno de la migracion (contapp_migrator) tampoco, aun con el contexto del estudio", async () => {
    const c = await clienteNuevo();
    const a = await ec.archivo(X, c, ux);
    for (const sql of [
      "update archivo_generado set lineas = 99 where id = $1",
      "delete from archivo_generado where id = $1",
    ]) {
      const r = await comoMigrador(sql, [a.id]);
      expect(r.code, sql).toBe("42501");
    }
    expect(await contarEn(admin, "archivo_generado", "id = $1", [a.id])).toBe(
      1,
    );
  });
});

// =================================================================================================
describe("0040 · insercion por el worker: periodo `generado` por el mismo usuario y version = max + 1 (D4, D6, CA-7)", () => {
  it.each<[Libro]>([["compras"], ["ventas"]])(
    "%s: con el periodo generado por quien genera, la version 1 entra; la fila queda legible por el backend",
    async (libro) => {
      const c = await clienteNuevo();
      await ec.periodoDe(libro, X, c, PERIODO, "generado", ux);
      const d = datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c), {
        libro,
      });
      expect(await insertarComoWorker(d)).toBe("ok");
      const filas = await backend.withTenant({ tenantId: X }, (tx) =>
        tx.query(
          "select version, libro, encode(sha256_zip, 'hex') as h from archivo_generado where cliente_id = $1",
          [c.id],
        ),
      );
      expect(filas.rows).toEqual([{ version: 1, libro, h: HEX("b") }]);
    },
  );

  it.each<[string, "abierto" | "revisado" | null]>([
    ["abierto", "abierto"],
    ["revisado", "revisado"],
    ["sin fila de periodo", null],
  ])("con el periodo %s no se inserta (23514)", async (_n, estado) => {
    const c = await clienteNuevo();
    if (estado) await ec.periodoDe("compras", X, c, PERIODO, estado, ux);
    const d = datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c));
    expect(await insertarComoWorker(d)).toBe("23514");
    expect(
      await contarEn(admin, "archivo_generado", "cliente_id = $1", [c.id]),
    ).toBe(0);
  });

  it("el estado tiene que ser el del MISMO libro: compras generado no sirve para ventas, ni al reves", async () => {
    const c = await clienteNuevo();
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    const v = datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c), {
      libro: "ventas",
      impactoDg: null,
      impactoDgng: null,
      impactoDng: null,
    });
    expect(await insertarComoWorker(v)).toBe("23514");
    const c2 = await clienteNuevo();
    await ec.periodoDe("ventas", X, c2, PERIODO, "generado", ux);
    const k = datosArchivo(X, c2, ux, await ec.trabajoArchivo(X, c2));
    expect(await insertarComoWorker(k)).toBe("23514");
  });

  it("el periodo tiene que estar generado para ESE cliente y ESE periodo", async () => {
    const c = await clienteNuevo();
    const otro = await clienteNuevo();
    await ec.periodoDe("compras", X, otro, PERIODO, "generado", ux);
    await ec.periodoDe("compras", X, c, "202609", "generado", ux);
    const d = datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c));
    expect(await insertarComoWorker(d), "periodo 202610 sin generar").toBe(
      "23514",
    );
  });

  it("generado por OTRO usuario: la version no entra (23514); con el mismo usuario si", async () => {
    const c = await clienteNuevo();
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux2);
    const d = datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c));
    expect(await insertarComoWorker(d)).toBe("23514");
    expect(await insertarComoWorker({ ...d, generadoPor: ux2, id: d.id })).toBe(
      "ok",
    );
  });

  it("la version es max + 1 por (cliente, periodo, libro): saltarse una, repetir o empezar en 2 dan 23514", async () => {
    const c = await clienteNuevo();
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    const t = () => ec.trabajoArchivo(X, c);
    expect(
      await insertarComoWorker(
        datosArchivo(X, c, ux, await t(), { version: 2 }),
      ),
      "empezar en 2",
    ).toBe("23514");
    expect(
      await insertarComoWorker(
        datosArchivo(X, c, ux, await t(), { version: 1 }),
      ),
    ).toBe("ok");
    expect(
      await insertarComoWorker(
        datosArchivo(X, c, ux, await t(), { version: 1 }),
      ),
      "repetir la 1",
    ).toBe("23514");
    expect(
      await insertarComoWorker(
        datosArchivo(X, c, ux, await t(), { version: 3 }),
      ),
      "saltar la 2",
    ).toBe("23514");
    expect(
      await insertarComoWorker(
        datosArchivo(X, c, ux, await t(), { version: 2 }),
      ),
    ).toBe("ok");
    expect(
      await insertarComoWorker(
        datosArchivo(X, c, ux, await t(), { version: 3 }),
      ),
    ).toBe("ok");
    expect(
      await contarEn(admin, "archivo_generado", "cliente_id = $1", [c.id]),
    ).toBe(3);
  });

  it("numeracion independiente por cliente, periodo y libro: cada serie empieza en 1", async () => {
    const c = await clienteNuevo();
    const otro = await clienteNuevo();
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    await ec.periodoDe("compras", X, c, "202609", "generado", ux);
    await ec.periodoDe("ventas", X, c, PERIODO, "generado", ux);
    await ec.periodoDe("compras", X, otro, PERIODO, "generado", ux);
    const nuevo = async (cliente: ClientePrueba, o: Partial<DatosArchivo>) =>
      datosArchivo(X, cliente, ux, await ec.trabajoArchivo(X, cliente), o);
    const ventas = {
      libro: "ventas" as Libro,
      impactoDg: null,
      impactoDgng: null,
      impactoDng: null,
    };
    expect(await insertarComoWorker(await nuevo(c, {}))).toBe("ok");
    expect(await insertarComoWorker(await nuevo(c, { version: 2 }))).toBe("ok");
    expect(
      await insertarComoWorker(await nuevo(c, { periodo: "202609" })),
      "otro periodo",
    ).toBe("ok");
    expect(await insertarComoWorker(await nuevo(c, ventas)), "otro libro").toBe(
      "ok",
    );
    expect(
      await insertarComoWorker(await nuevo(otro, {})),
      "otro cliente",
    ).toBe("ok");
    expect(await insertarComoWorker(await nuevo(c, { version: 3 }))).toBe("ok");
  });

  it("un trabajo_id repetido con la version siguiente da 23505 (el reintento no crea otra fila)", async () => {
    const c = await clienteNuevo();
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    const d = datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c));
    expect(await insertarComoWorker(d)).toBe("ok");
    expect(
      await insertarComoWorker({
        ...d,
        id: "11111111-1111-4111-8111-111111111111",
        version: 2,
        ruta: `archivos/${X}/${c.id}/11111111-1111-4111-8111-111111111111.zip`,
      }),
    ).toBe("23505");
  });

  it("el backend no inserta ni con el periodo generado (sin INSERT: 42501, CA-9)", async () => {
    const c = await clienteNuevo();
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    const d = datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c));
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: X },
          INSERTAR_ARCHIVO,
          valoresArchivo(d),
        ),
      ),
    ).toBe("42501");
    expect(
      await contarEn(admin, "archivo_generado", "cliente_id = $1", [c.id]),
    ).toBe(0);
  });

  it("los mensajes de rechazo del trigger no llevan datos del cliente", async () => {
    const c = await clienteNuevo();
    const d = datosArchivo(X, c, ux, await ec.trabajoArchivo(X, c));
    const r = await intentar(
      worker,
      { tenantId: X },
      INSERTAR_ARCHIVO,
      valoresArchivo(d),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code, "lo rechaza el trigger de insercion").toBe("23514");
      for (const dato of [c.id, c.ruc, d.huella, d.nombreZip, d.ruta, X])
        expect(r.message, "el mensaje del trigger es fijo").not.toContain(dato);
    }
  });
});

// =================================================================================================
describe("0040 · aislamiento por estudio (CA-9)", () => {
  it("el otro estudio y la consulta sin contexto ven 0 filas; no se inserta con un tenant ajeno ni para un cliente ajeno", async () => {
    const c = await clienteNuevo();
    const a = await ec.archivo(X, c, ux);
    expect(
      (
        await backend.withTenant({ tenantId: X }, (tx) =>
          tx.query("select id from archivo_generado where id = $1", [a.id]),
        )
      ).rows,
    ).toHaveLength(1);
    for (const db of [backend, worker])
      expect(
        (
          await db.withTenant({ tenantId: Y }, (tx) =>
            tx.query("select id from archivo_generado where id = $1", [a.id]),
          )
        ).rows,
      ).toEqual([]);
    for (const rol of ["contapp_backend", "contapp_worker"])
      expect(
        await filasRaw(
          app,
          rol,
          "select id from archivo_generado where id = $1",
          [a.id],
        ),
        `${rol} sin contexto`,
      ).toEqual([]);

    await ec.periodoDe("compras", Y, cy, PERIODO, "generado", uy);
    const ajeno = datosArchivo(Y, cy, uy, await ec.trabajoArchivo(Y, cy));
    // Con el contexto del estudio X, escribir una fila con tenant_id = Y lo rechaza la politica de RLS (WITH CHECK).
    // (el trigger de insercion corre antes que la politica y no ve el periodo del estudio Y: tambien lo rechaza, con 23514)
    expect(["42501", "23514"]).toContain(
      await ec.insertarComoRol("contapp_worker", X, ajeno),
    );
    // Con el contexto correcto (control) la misma fila entra: el rechazo anterior fue por el estudio.
    expect(await ec.insertarComoRol("contapp_worker", Y, ajeno)).toBe("ok");
    // Un cliente de otro estudio bajo el contexto de X por la via normal tampoco entra.
    expect(
      codigo(
        await intentar(
          worker,
          { tenantId: X },
          INSERTAR_ARCHIVO,
          valoresArchivo(ajeno),
        ),
      ),
    ).not.toBe("ok");
    expect(
      await contarEn(admin, "archivo_generado", "cliente_id = $1", [cy.id]),
    ).toBe(0);
  });

  it("el worker del estudio Y inserta la suya sin ver la de X", async () => {
    await ec.periodoDe("compras", Y, cy, "202608", "generado", uy);
    const d = datosArchivo(Y, cy, uy, await ec.trabajoArchivo(Y, cy), {
      periodo: "202608",
    });
    expect(await insertarComoWorker(d, Y)).toBe("ok");
    expect(
      (
        await worker.withTenant({ tenantId: X }, (tx) =>
          tx.query("select id from archivo_generado where cliente_id = $1", [
            cy.id,
          ]),
        )
      ).rows,
    ).toEqual([]);
  });
});

// =================================================================================================
describe("limpieza de soporte: `limpiar` borra archivo_generado, venta_exclusion y venta_periodo (salta el trigger con replica)", () => {
  it("tras limpiar no queda nada de un estudio que tenia versiones, exclusiones y estado de ventas", async () => {
    const ec2 = new EscenarioArchivos(admin);
    const T = (await ec2.estudio()).id;
    const c = await ec2.cliente(T);
    const u = await ec2.usuarioDe(T);
    const v = await ec2.venta(T, c, {
      origen: "sire",
      serie: "B001",
      numero: "1",
    });
    await ec2.periodoDe("ventas", T, c, PERIODO, "generado", u);
    await ec2.periodoDe("compras", T, c, PERIODO, "generado", u);
    await ec2.exclusion(T, c.id, v, { por: u });
    await ec2.archivo(T, c, u);
    for (const tabla of [
      "archivo_generado",
      "venta_exclusion",
      "venta_periodo",
    ])
      expect(
        await contarEn(admin, tabla, "tenant_id = $1", [T]),
        `${tabla} sembrada`,
      ).toBeGreaterThan(0);
    await ec2.limpiar();
    for (const tabla of [
      "archivo_generado",
      "venta_exclusion",
      "venta_periodo",
      "compra_periodo",
      "venta",
    ])
      expect(
        await contarEn(admin, tabla, "tenant_id = $1", [T]),
        `${tabla} tras limpiar`,
      ).toBe(0);
    expect(await contarEn(admin, "tenant", "id = $1", [T])).toBe(0);
  });
});
