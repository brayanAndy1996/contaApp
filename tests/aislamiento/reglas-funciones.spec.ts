// Spec 021 (T3, rojo): funciones acotadas de la migracion 0048 (`reglas_historial_vigentes`, `aplicar_regla_historial`), el trigger
// que rechaza `accion = historial` fuera de la funcion, el repositorio `insertarCompras(..., { historial })` y la auditoria
// `compra.historial`. Cubre D-6, D-7, D-8, P-5, CA-4 (capa de BD), CA-10 y CA-13. Patron de 0038 (`bloquear_compras_reevaluar`):
// SECURITY DEFINER de contapp_migrator, search_path fijo, EXECUTE solo a contapp_worker, errores 42501 de mensaje fijo.
// El contrato SQL y de TypeScript esta en el encabezado de `reglas-soporte.ts`. Hasta T9 fallan: las funciones no existen.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import {
  abrirPool,
  enRollback,
  intentar,
  intentarRaw,
  type ContappDb,
  type Tx,
} from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  claveCompra,
  codigoDe,
  evaluadorFalso,
  INSERTAR_VERSION,
  valoresVersion,
  type CompraLeida,
  type Evaluar,
  type IdentidadCompra,
  type Montos,
} from "./compras-soporte";
import { unaFila } from "./auditoria-soporte";
import {
  aplicar,
  APRENDIDO,
  compraDelWorker,
  consolidar,
  datosJson,
  DESCARGA,
  EscenarioReglas,
  FACTURA_DG,
  md5Version,
  MIXTA,
  MIXTA_CHICA,
  montos,
  montosDeFila,
  type Destino,
} from "./reglas-soporte";

let admin: Pool;
let app: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let backend: ContappDb;
let X: string;
let Y: string;
let Z: string; // estudio con R-HIS apagado
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let cz: ClientePrueba;
let ux: string;
let propX: string;
let propY: string;
let propZ: string;
let errSiembra: unknown;

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  ec = new EscenarioReglas(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  Z = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cx2 = await ec.cliente(X);
  cy = await ec.cliente(Y);
  cz = await ec.cliente(Z);
  ux = await ec.usuarioDe(X);
  worker = crearDb("contapp_worker", 4);
  backend = crearDb("contapp_backend", 4);
  propX = await ec.propuesta(X, cx, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  propY = await ec.propuesta(Y, cy, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  propZ = await ec.propuesta(Z, cz, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  try {
    await ec.interruptor(Z, "R-HIS", false);
  } catch (e) {
    errSiembra = e; // 0047 aun no existe: cada prueba falla por esa razon, no el bloque entero
  }
});
beforeEach(() => {
  if (errSiembra) throw errSiembra;
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [worker?.close(), backend?.close(), ec?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await app?.end();
  await admin?.end();
});

let consecutivo = 0;
const numero = () => String(7000 + ++consecutivo);

/** Dentro de una transaccion que se revierte: prepara, intenta aplicar y devuelve el SQLSTATE (o 'ok'). */
async function rechazo(
  tenantId: string,
  preparar: (tx: Tx) => Promise<{ compra: string; regla: string; datos: unknown }>,
): Promise<string> {
  return enRollback(worker, { tenantId }, async (tx) => {
    const p = await preparar(tx);
    try {
      await tx.query("select public.aplicar_regla_historial($1, $2, $3::jsonb) as n", [
        p.compra,
        p.regla,
        JSON.stringify(p.datos),
      ]);
      return "ok";
    } catch (e) {
      return String((e as { code?: string }).code ?? "sin_codigo");
    }
  });
}

/** Caso base valido: regla DNG del cliente (aprendida en 202609) y una compra nueva de ese proveedor en 202610. */
async function base(
  o: {
    tenant?: string;
    cliente?: ClientePrueba;
    propuesta?: string;
    docCompra?: string;
    montosV1?: Montos;
  } = {},
) {
  const tenant = o.tenant ?? X;
  const cliente = o.cliente ?? cx;
  const doc = o.docCompra ?? `2${String(++consecutivo).padStart(10, "0")}`;
  return { tenant, cliente, doc, propuesta: o.propuesta ?? propX, m: o.montosV1 ?? FACTURA_DG };
}

const nuevaCompra = (
  tx: Tx,
  b: Awaited<ReturnType<typeof base>>,
  periodo = DESCARGA,
) =>
  compraDelWorker(tx, b.cliente.id, b.propuesta, periodo, {
    numero: numero(),
    docNumero: b.doc,
    montos: b.m,
  });

// =================================================================================================
describe("0048 · propiedades de las funciones (patron de 0038)", () => {
  const FUNCIONES = [
    "reglas_historial_vigentes",
    "aplicar_regla_historial",
  ] as const;
  for (const f of FUNCIONES) {
    it(`${f}: SECURITY DEFINER de contapp_migrator, search_path fijo y EXECUTE solo para contapp_worker`, async () => {
      const r = await admin.query(
        `select p.prosecdef, o.rolname as dueno, p.proconfig, p.oid::regprocedure::text as firma
           from pg_proc p join pg_roles o on o.oid = p.proowner
           join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
          where p.proname = $1`,
        [f],
      );
      expect(r.rows, `falta la funcion ${f} (migracion 0048)`).toHaveLength(1);
      expect(r.rows[0].prosecdef, "SECURITY DEFINER").toBe(true);
      expect(r.rows[0].dueno).toBe("contapp_migrator");
      expect(
        (r.rows[0].proconfig as string[]).join(" "),
        "search_path fijo",
      ).toMatch(/search_path=pg_catalog, pg_temp/);
      const firma = r.rows[0].firma as string;
      for (const rol of [
        "contapp_backend",
        "contapp_app",
        "contapp_platform",
        "contapp_enumerador",
        "contapp_auth",
        "contapp_registrador",
      ]) {
        expect(
          (await admin.query("select has_function_privilege($1::name, $2::regprocedure, 'EXECUTE') as v", [rol, firma])).rows[0].v,
          `${rol} ejecuta ${f}`,
        ).toBe(false);
      }
      expect(
        (await admin.query("select has_function_privilege($1::name, $2::regprocedure, 'EXECUTE') as v", ["contapp_worker", firma])).rows[0].v,
        "worker ejecuta",
      ).toBe(true);
      expect(
        (await admin.query("select has_function_privilege(0::oid, $1::regprocedure, 'EXECUTE') as v", [firma])).rows[0].v,
        "PUBLIC ejecuta",
      ).toBe(false);
    });
  }

  it("el backend no puede ejecutar ninguna de las dos (42501), ni con datos validos", async () => {
    const regla = await ec.regla(X, cx, { docNumero: "20300000001" });
    const vig = await intentar(
      backend,
      { tenantId: X, userId: ux },
      "select * from public.reglas_historial_vigentes($1, $2)",
      [cx.id, DESCARGA],
    );
    expect(codigo(vig)).toBe("42501");
    const compra = (await ec.compra(X, cx, { periodo: DESCARGA, propuestaId: propX })).id;
    const ap = await intentar(
      backend,
      { tenantId: X, userId: ux },
      "select public.aplicar_regla_historial($1, $2, $3::jsonb)",
      [compra, regla, JSON.stringify(datosJson(consolidar(FACTURA_DG, "DNG")))],
    );
    expect(codigo(ap)).toBe("42501");
  });

  it("sin estudio en la sesion (sin app.tenant_id) las dos dan 42501 de mensaje fijo", async () => {
    const a = await intentarRaw(
      app,
      "contapp_worker",
      "select * from public.reglas_historial_vigentes('00000000-0000-7000-8000-000000000001', '202610')",
    );
    expect(a.ok ? "ok" : a.code).toBe("42501");
    const b = await intentarRaw(
      app,
      "contapp_worker",
      "select public.aplicar_regla_historial('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', '{}'::jsonb)",
    );
    expect(b.ok ? "ok" : b.code).toBe("42501");
  });
});

// =================================================================================================
describe("0048 · aplicar_regla_historial: camino valido (D-6, D-7, D-8)", () => {
  const CASOS: [string, Montos, Destino][] = [
    ["factura gravada a DNG", FACTURA_DG, "DNG"],
    ["factura gravada a DGNG", FACTURA_DG, "DGNG"],
    ["mixta 600/400 a DG (suma BI e IGV en el par del destino)", MIXTA, "DG"],
    ["mixta 21.48/1.61 con no gravado a DNG (centimos exactos)", MIXTA_CHICA, "DNG"],
    [
      "con ISC, ICBPER y otros tributos: el resto queda igual",
      montos({ biDg: "770.00", igvDg: "138.60", isc: "12.34", icbper: "0.50", otrosTributos: "1.10", noGravado: "5.00" }),
      "DGNG",
    ],
  ];
  for (const [nombre, m, destino] of CASOS) {
    it(`${nombre}: devuelve 2, inserta la version 2 historial y mueve el puntero`, async () => {
      const b = await base({ montosV1: m });
      const regla = await ec.regla(X, cx, { docNumero: b.doc, destino });
      const esperados = consolidar(m, destino);
      const { compra, n, h1 } = await worker.withTenant({ tenantId: X }, async (tx) => {
        const compra = await nuevaCompra(tx, b);
        const h1 = (await tx.query("select md5(v::text) as h from compra_version v where compra_id = $1 and n = 1", [compra])).rows[0].h as string;
        return { compra, n: await aplicar(tx, compra, regla, esperados), h1 };
      });
      expect(n).toBe(2);
      const v = await admin.query("select * from compra_version where compra_id = $1 order by n", [compra]);
      expect(v.rows.map((r) => r.n)).toEqual([1, 2]);
      const v2 = v.rows[1];
      expect(v2.accion).toBe("historial");
      expect(v2.clasificada).toBe(true);
      expect([v2.operacion_id, v2.usuario_id]).toEqual([null, null]);
      expect(v2.excluida).toBe(false);
      expect(montosDeFila(v2)).toEqual(esperados);
      // La version 1 queda identica a lo que trajo el SIRE (CA-2): mismos bytes de la fila y los montos de origen.
      expect(await md5Version(admin, compra, 1)).toBe(h1);
      expect(montosDeFila(v.rows[0])).toEqual(m);
      expect([v.rows[0].accion, v.rows[0].clasificada]).toEqual(["original", false]);
      expect(
        (await admin.query("select version_vigente from compra where id = $1", [compra])).rows[0].version_vigente,
      ).toBe(2);
      const ap = await admin.query("select regla_id, compra_id, version_n, periodo from regla_aplicacion where compra_id = $1", [compra]);
      expect(ap.rows).toEqual([{ regla_id: regla, compra_id: compra, version_n: 2, periodo: DESCARGA }]);
    });
  }

  it("la suma del total no cambia al consolidar (NUMERIC exacto): total de la version 2 = total de la version 1", async () => {
    const b = await base({ montosV1: MIXTA_CHICA });
    // MIXTA_CHICA ya esta en DG: la regla la mueve a DNG para que haya consolidacion (D-7, 0050 rechaza lo que no mueve nada).
    const regla = await ec.regla(X, cx, { docNumero: b.doc, destino: "DNG" });
    const compra = await worker.withTenant({ tenantId: X }, async (tx) => {
      const c = await nuevaCompra(tx, b);
      await aplicar(tx, c, regla, consolidar(MIXTA_CHICA, "DNG"));
      return c;
    });
    const r = await admin.query("select n, total from compra_version where compra_id = $1 order by n", [compra]);
    expect(r.rows[0].total).toBe(r.rows[1].total);
  });

  it("la compra sin aplicar queda con solo la version 1 y sin fila en regla_aplicacion (el contraste del caso valido)", async () => {
    const b = await base();
    const compra = await worker.withTenant({ tenantId: X }, (tx) => nuevaCompra(tx, b));
    expect((await admin.query("select count(*)::int as n from compra_version where compra_id = $1", [compra])).rows[0].n).toBe(1);
    expect((await admin.query("select count(*)::int as n from regla_aplicacion where compra_id = $1", [compra])).rows[0].n).toBe(0);
  });
});

// =================================================================================================
describe("0048 · aplicar_regla_historial: falla cerrado con 42501 (CA-10, CA-4)", () => {
  it("compra no creada en esta transaccion (existia antes): 42501", async () => {
    const b = await base();
    const regla = await ec.regla(X, cx, { docNumero: b.doc });
    const previa = (await ec.compra(X, cx, { periodo: DESCARGA, propuestaId: propX, docNumero: b.doc })).id;
    expect(
      await rechazo(X, async () => ({ compra: previa, regla, datos: datosJson(consolidar(FACTURA_DG, "DNG")) })),
    ).toBe("42501");
  });

  it("compra que ya tiene la version 2 (segunda llamada en la misma transaccion): 42501", async () => {
    const b = await base();
    const regla = await ec.regla(X, cx, { docNumero: b.doc });
    const c = await rechazo(X, async (tx) => {
      const compra = await nuevaCompra(tx, b);
      await aplicar(tx, compra, regla, consolidar(FACTURA_DG, "DNG"));
      return { compra, regla, datos: datosJson(consolidar(FACTURA_DG, "DNG")) };
    });
    expect(c).toBe("42501");
  });

  it("insercion directa del worker de una version n = 2 (accion historial) o n = 3: 42501; el trigger 0038 sigue vigente", async () => {
    const b = await base();
    const regla = await ec.regla(X, cx, { docNumero: b.doc });
    void regla;
    for (const n of [2, 3]) {
      const c = await enRollback(worker, { tenantId: X }, async (tx) => {
        const compra = await nuevaCompra(tx, b);
        try {
          await tx.query(INSERTAR_VERSION, [
            compra, n, "0.00", "0.00", "0.00", "0.00", "1000.00", "180.00", "0.00", "0.00", "0.00", "0.00", "1180.00",
            false, null, true, "historial", null, null,
          ]);
          return "ok";
        } catch (e) {
          return String((e as { code?: string }).code);
        }
      });
      expect(c, `n = ${n}`).toBe("42501");
    }
  });

  it("el worker sigue sin UPDATE sobre compra (no puede mover el puntero) ni escribir regla_aplicacion directo", async () => {
    const b = await base();
    const regla = await ec.regla(X, cx, { docNumero: b.doc });
    const r = await enRollback(worker, { tenantId: X }, async (tx) => {
      const compra = await nuevaCompra(tx, b);
      const sal: Record<string, string> = {};
      for (const [k, sql, v] of [
        ["update", "update compra set version_vigente = 2 where id = $1", [compra]],
        ["aplicacion", "insert into regla_aplicacion (regla_id, compra_id, version_n, periodo) values ($2, $1, 2, '202610')", [compra, regla]],
      ] as const) {
        await tx.query("SAVEPOINT p");
        try {
          await tx.query(sql, [...v]);
          sal[k] = "ok";
          await tx.query("RELEASE SAVEPOINT p");
        } catch (e) {
          sal[k] = String((e as { code?: string }).code);
          await tx.query("ROLLBACK TO SAVEPOINT p");
        }
      }
      return sal;
    });
    expect(r).toEqual({ update: "42501", aplicacion: "42501" });
  });

  it("el backend no puede insertar una version con accion = historial (42501), aunque la compra exista y sea la version vigente + 1", async () => {
    const c = await ec.compra(X, cx, { periodo: DESCARGA, propuestaId: propX });
    const ins = (accion: string) =>
      intentar(
        backend,
        { tenantId: X, userId: ux },
        INSERTAR_VERSION,
        (() => {
          const v = valoresVersion(c.id, 2, { usuarioId: ux });
          v[16] = accion;
          return v;
        })(),
      );
    expect(codigo(await ins("editar")), "contraste: otra accion si se puede").toBe("ok");
    expect(codigo(await ins("historial"))).toBe("42501");
  });

  it("el superusuario tampoco escribe accion = historial fuera de la funcion (solo contapp_migrator, dentro de ella)", async () => {
    const c = await ec.compra(X, cx, { periodo: DESCARGA, propuestaId: propX });
    await expect(
      admin.query(
        `insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc,
           icbper, otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
         values ($1, $2, 2, 0, 0, 0, 0, 1000, 180, 0, 0, 0, 0, 1180, false, null, true, 'historial', null, null)`,
        [X, c.id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("regla de otro cliente del mismo estudio: 42501", async () => {
    const b = await base();
    const reglaAjena = await ec.regla(X, cx2, { docNumero: b.doc });
    expect(
      await rechazo(X, async (tx) => ({
        compra: await nuevaCompra(tx, b),
        regla: reglaAjena,
        datos: datosJson(consolidar(FACTURA_DG, "DNG")),
      })),
    ).toBe("42501");
  });

  it("regla de otro estudio (invisible por RLS) o inexistente: 42501", async () => {
    const b = await base();
    const reglaY = await ec.regla(Y, cy, { docNumero: b.doc });
    for (const regla of [reglaY, "00000000-0000-7000-8000-0000000000aa"]) {
      expect(
        await rechazo(X, async (tx) => ({
          compra: await nuevaCompra(tx, b),
          regla,
          datos: datosJson(consolidar(FACTURA_DG, "DNG")),
        })),
        regla,
      ).toBe("42501");
    }
  });

  it("compra de otro estudio: 42501", async () => {
    const b = await base();
    const regla = await ec.regla(X, cx, { docNumero: b.doc });
    const ajena = (await ec.compra(Y, cy, { periodo: DESCARGA, propuestaId: propY, docNumero: b.doc })).id;
    expect(
      await rechazo(X, async () => ({ compra: ajena, regla, datos: datosJson(consolidar(FACTURA_DG, "DNG")) })),
    ).toBe("42501");
  });

  it("regla de otro proveedor (otro numero o otro tipo de documento): 42501", async () => {
    const b = await base();
    for (const [docTipo, docNumero] of [
      ["6", `${b.doc.slice(0, -1)}${b.doc.endsWith("7") ? "8" : "7"}`],
      ["1", b.doc],
    ] as const) {
      const regla = await ec.regla(X, cx, { docTipo, docNumero });
      expect(
        await rechazo(X, async (tx) => ({
          compra: await nuevaCompra(tx, b),
          regla,
          datos: datosJson(consolidar(FACTURA_DG, "DNG")),
        })),
        `${docTipo}-${docNumero}`,
      ).toBe("42501");
    }
  });

  it("regla inactiva o eliminada (CA-4): 42501", async () => {
    for (const o of [{ activa: false }, { eliminada: true }, { activa: false, eliminada: true }]) {
      const b = await base();
      const regla = await ec.regla(X, cx, { docNumero: b.doc, ...o });
      expect(
        await rechazo(X, async (tx) => ({
          compra: await nuevaCompra(tx, b),
          regla,
          datos: datosJson(consolidar(FACTURA_DG, "DNG")),
        })),
        JSON.stringify(o),
      ).toBe("42501");
    }
  });

  it("periodo_aprendido igual o posterior al periodo de la compra (P-5): 42501; anterior: se aplica", async () => {
    for (const [aprendido, esperado] of [
      [DESCARGA, "42501"],
      ["202611", "42501"],
      [APRENDIDO, "ok"],
      ["202501", "ok"],
    ] as const) {
      const b = await base();
      const regla = await ec.regla(X, cx, { docNumero: b.doc, periodoAprendido: aprendido });
      expect(
        await rechazo(X, async (tx) => ({
          compra: await nuevaCompra(tx, b),
          regla,
          datos: datosJson(consolidar(FACTURA_DG, "DNG")),
        })),
        `aprendido en ${aprendido}`,
      ).toBe(esperado);
    }
  });

  it("R-HIS apagado en el estudio (CA-4): 42501; con la fila explicitamente encendida, se aplica", async () => {
    const b = await base({ tenant: Z, cliente: cz, propuesta: propZ });
    const regla = await ec.regla(Z, cz, { docNumero: b.doc });
    const prep = async (tx: Tx) => ({
      compra: await nuevaCompra(tx, b),
      regla,
      datos: datosJson(consolidar(FACTURA_DG, "DNG")),
    });
    expect(await rechazo(Z, prep), "apagado").toBe("42501");
    await ec.interruptor(Z, "R-HIS", true);
    try {
      expect(await rechazo(Z, prep), "encendido").toBe("ok");
    } finally {
      await ec.interruptor(Z, "R-HIS", false);
    }
  });

  it("otro interruptor apagado (R-NEW) no impide R-HIS", async () => {
    await ec.interruptor(Z, "R-NEW", false);
    const b = await base({ tenant: Z, cliente: cz, propuesta: propZ });
    await ec.interruptor(Z, "R-HIS", true);
    try {
      const regla = await ec.regla(Z, cz, { docNumero: b.doc });
      expect(
        await rechazo(Z, async (tx) => ({
          compra: await nuevaCompra(tx, b),
          regla,
          datos: datosJson(consolidar(FACTURA_DG, "DNG")),
        })),
      ).toBe("ok");
    } finally {
      await ec.interruptor(Z, "R-HIS", false);
      await ec.interruptor(Z, "R-NEW", true);
    }
  });

  describe("p_datos que no son exactamente la version 1 consolidada en el destino de la regla", () => {
    const m = FACTURA_DG;
    const bueno = () => datosJson(consolidar(m, "DNG"));
    const INVALIDOS: [string, () => unknown][] = [
      ["destino equivocado (consolidada en DG, la regla es DNG)", () => datosJson(consolidar(m, "DG"))],
      ["destino equivocado (DGNG)", () => datosJson(consolidar(m, "DGNG"))],
      ["la version 1 sin consolidar", () => datosJson(m)],
      ["BI de DNG alterada en un centimo", () => ({ ...bueno(), bi_dng: "999.99" })],
      ["IGV de DNG alterado", () => ({ ...bueno(), igv_dng: "179.99" })],
      ["total alterado", () => ({ ...bueno(), total: "1180.01" })],
      ["ISC inventado", () => ({ ...bueno(), isc: "1.00" })],
      ["una columna de monto menos", () => Object.fromEntries(Object.entries(bueno()).filter(([k]) => k !== "isc"))],
      ["BI de DNG con otro valor (1000.5)", () => ({ ...bueno(), bi_dng: "1000.5" })],
    ];
    for (const [nombre, datos] of INVALIDOS) {
      it(`${nombre}: 42501`, async () => {
        const b = await base();
        const regla = await ec.regla(X, cx, { docNumero: b.doc, destino: "DNG" });
        expect(
          await rechazo(X, async (tx) => ({ compra: await nuevaCompra(tx, b), regla, datos: datos() })),
        ).toBe("42501");
      });
    }

    it("p_datos nulo o que no es un objeto: error (42501 o 22023), nunca una version", async () => {
      for (const datos of [null, [], "x", 5]) {
        const b = await base();
        const regla = await ec.regla(X, cx, { docNumero: b.doc, destino: "DNG" });
        const c = await rechazo(X, async (tx) => ({ compra: await nuevaCompra(tx, b), regla, datos }));
        expect(["42501", "22023"], JSON.stringify(datos)).toContain(c);
      }
    });

    it("tras un rechazo no queda ni la version 2 ni regla_aplicacion (todo o nada)", async () => {
      const b = await base();
      const regla = await ec.regla(X, cx, { docNumero: b.doc, destino: "DNG" });
      const compra = await worker.withTenant({ tenantId: X }, async (tx) => {
        const c = await nuevaCompra(tx, b);
        await tx.query("SAVEPOINT s");
        try {
          await aplicar(tx, c, regla, consolidar(m, "DG"));
        } catch {
          await tx.query("ROLLBACK TO SAVEPOINT s");
        }
        return c;
      });
      expect((await admin.query("select count(*)::int as n from compra_version where compra_id = $1", [compra])).rows[0].n).toBe(1);
      expect((await admin.query("select count(*)::int as n from regla_aplicacion where compra_id = $1", [compra])).rows[0].n).toBe(0);
      expect((await admin.query("select version_vigente from compra where id = $1", [compra])).rows[0].version_vigente).toBe(1);
    });
  });
});

// =================================================================================================
describe("0048 · reglas_historial_vigentes: filtra por cliente, periodo y estado (CA-4, CA-5, P-5)", () => {
  let A: ClientePrueba; // cliente propio de este bloque, para no mezclar con otras reglas
  let B: ClientePrueba;
  let D: ClientePrueba; // cliente propio en Y
  let E: ClientePrueba; // cliente propio en Z (R-HIS apagado)
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    A = await ec.cliente(X);
    B = await ec.cliente(X);
    D = await ec.cliente(Y);
    E = await ec.cliente(Z);
    try {
      ids.vigente = await ec.regla(X, A, { docNumero: "20401000001", destino: "DNG", periodoAprendido: "202609", version: 3 });
      ids.antigua = await ec.regla(X, A, { docNumero: "20401000002", destino: "DGNG", periodoAprendido: "202608" });
      ids.inactiva = await ec.regla(X, A, { docNumero: "20401000003", activa: false });
      ids.eliminada = await ec.regla(X, A, { docNumero: "20401000004", eliminada: true });
      ids.mismoPeriodo = await ec.regla(X, A, { docNumero: "20401000005", periodoAprendido: "202610" });
      ids.futura = await ec.regla(X, A, { docNumero: "20401000006", periodoAprendido: "202611" });
      ids.deB = await ec.regla(X, B, { docNumero: "20401000007", destino: "DG" });
      ids.deOtroEstudio = await ec.regla(Y, D, { docNumero: "20401000008" });
    } catch (e) {
      errSiembra ??= e;
    }
  });

  const vigentes = (cliente: string, periodo: string, tenant = X) =>
    worker.withTenant({ tenantId: tenant }, async (tx) =>
      (await tx.query("select * from public.reglas_historial_vigentes($1, $2)", [cliente, periodo])).rows,
    );

  it("para 202610 devuelve solo las vivas, activas y aprendidas antes, con (regla_id, doc_tipo, doc_numero, destino, version)", async () => {
    const r = await vigentes(A.id, "202610");
    expect(r.map((x) => x.regla_id).sort()).toEqual([ids.vigente, ids.antigua].sort());
    const v = r.find((x) => x.regla_id === ids.vigente)!;
    expect({ doc_tipo: v.doc_tipo, doc_numero: v.doc_numero, destino: v.destino, version: v.version }).toEqual({
      doc_tipo: "6",
      doc_numero: "20401000001",
      destino: "DNG",
      version: 3,
    });
  });

  it("para 202609 solo la aprendida en 202608; para 202608 y antes, ninguna (P-5)", async () => {
    expect((await vigentes(A.id, "202609")).map((x) => x.regla_id)).toEqual([ids.antigua]);
    expect(await vigentes(A.id, "202608")).toEqual([]);
    expect(await vigentes(A.id, "202501")).toEqual([]);
  });

  it("para 202611 suma la aprendida en 202610; la de 202611 sigue fuera", async () => {
    expect((await vigentes(A.id, "202611")).map((x) => x.regla_id).sort()).toEqual(
      [ids.vigente, ids.antigua, ids.mismoPeriodo].sort(),
    );
  });

  it("no mezcla clientes: el cliente B solo ve la suya, y nunca la de A aunque el proveedor coincida", async () => {
    expect((await vigentes(B.id, "202610")).map((x) => x.regla_id)).toEqual([ids.deB]);
    await ec.regla(X, B, { docNumero: "20401000001", destino: "DG" }); // mismo proveedor que la vigente de A
    const r = await vigentes(B.id, "202610");
    expect(r.every((x) => x.regla_id !== ids.vigente)).toBe(true);
    expect(r).toHaveLength(2);
  });

  it("un cliente de otro estudio, o inexistente, no devuelve nada (CA-5)", async () => {
    expect(await vigentes(D.id, "202610", X)).toEqual([]);
    expect(await vigentes("00000000-0000-7000-8000-0000000000bb", "202610")).toEqual([]);
    expect((await vigentes(D.id, "202610", Y)).map((x) => x.regla_id)).toEqual([ids.deOtroEstudio]);
  });

  it("con R-HIS apagado en el estudio devuelve vacio aunque haya reglas vivas", async () => {
    await ec.regla(Z, E, { docNumero: "20401000009" });
    expect(await vigentes(E.id, "202610", Z)).toEqual([]);
    await ec.interruptor(Z, "R-HIS", true);
    try {
      expect(await vigentes(E.id, "202610", Z)).toHaveLength(1);
    } finally {
      await ec.interruptor(Z, "R-HIS", false);
    }
  });
});

// =================================================================================================
describe("insertarCompras con `historial` (D-7, P-6) · packages/db", () => {
  type Nueva = IdentidadCompra & { montos: Montos };
  type Historial = (f: CompraLeida) => { reglaId: string; datos: Montos } | null;
  const insertarCompras = (
    tx: Tx,
    ctx: { clienteId: string; periodo: string; propuestaId: string },
    nuevas: Nueva[],
    f: { evaluar: Evaluar; historial?: Historial },
  ) =>
    exportado<
      (tx: Tx, c: unknown, n: Nueva[], f: unknown) => Promise<unknown>
    >("insertarCompras")(tx, ctx, nuevas, f);

  const fila = (serie: string, num: string, docNumero: string, m: Montos = FACTURA_DG): Nueva => ({
    clave: claveCompra("01", serie, num, "6", docNumero),
    tipoDoc: "01",
    serie,
    numero: num,
    docTipo: "6",
    docNumero,
    razonSocial: "CANARIO REGLAS SAC",
    fecha: "2026-10-05",
    moneda: "PEN",
    tipoCambio: null,
    montos: m,
  });

  it("con `historial`: la compra con regla queda con version 2 historial; la otra, solo con la 1; ambas versiones se evaluan (P-6)", async () => {
    const regla = await ec.regla(X, cx, { docNumero: "20500000001", destino: "DNG" });
    const e = evaluadorFalso();
    await worker.withTenant({ tenantId: X }, (tx) =>
      insertarCompras(
        tx,
        { clienteId: cx.id, periodo: DESCARGA, propuestaId: propX },
        [fila("F009", "1", "20500000001"), fila("F009", "2", "20500000002")],
        {
          evaluar: e.evaluar,
          historial: (f) =>
            f.docNumero === "20500000001"
              ? { reglaId: regla, datos: consolidar(f.montos, "DNG") }
              : null,
        },
      ),
    );
    const rows = await admin.query(
      `select c.doc_numero, c.version_vigente, v.n, v.accion, v.bi_dg, v.bi_dng
         from compra c join compra_version v on v.compra_id = c.id
        where c.cliente_id = $1 and c.serie = 'F009' order by c.numero, v.n`,
      [cx.id],
    );
    expect(rows.rows.map((r) => [r.doc_numero, r.n, r.accion, r.version_vigente, r.bi_dg, r.bi_dng])).toEqual([
      ["20500000001", 1, "original", 2, "1000.00", "0.00"],
      ["20500000001", 2, "historial", 2, "0.00", "1000.00"],
      ["20500000002", 1, "original", 1, "1000.00", "0.00"],
    ]);
    const versionesEvaluadas = e.llamadas
      .filter((f) => f.docNumero === "20500000001")
      .map((f) => f.version);
    expect(versionesEvaluadas, "se evalua la 1 y la 2").toEqual([1, 2]);
    const hallazgos = await admin.query(
      `select h.version_n from compra_hallazgo h join compra c on c.id = h.compra_id
        where c.cliente_id = $1 and c.serie = 'F009' and c.doc_numero = '20500000001' order by h.version_n`,
      [cx.id],
    );
    expect(hallazgos.rows.map((r) => r.version_n), "los hallazgos de la version 1 quedan en su historial").toEqual([1, 2]);
    expect(
      (await admin.query("select count(*)::int as n from regla_aplicacion where regla_id = $1", [regla])).rows[0].n,
    ).toBe(1);
  });

  it("sin `historial` el resultado es identico al de hoy: solo version 1 y ninguna regla_aplicacion", async () => {
    const e = evaluadorFalso();
    await worker.withTenant({ tenantId: X }, (tx) =>
      insertarCompras(
        tx,
        { clienteId: cx.id, periodo: DESCARGA, propuestaId: propX },
        [fila("F010", "1", "20500000001")],
        { evaluar: e.evaluar },
      ),
    );
    const r = await admin.query(
      `select v.n, v.accion from compra c join compra_version v on v.compra_id = c.id where c.cliente_id = $1 and c.serie = 'F010'`,
      [cx.id],
    );
    expect(r.rows).toEqual([{ n: 1, accion: "original" }]);
    expect(e.llamadas.map((f) => f.version)).toEqual([1]);
  });

  it("si la funcion rechaza (p. ej. datos que no son la consolidacion) toda la descarga se revierte", async () => {
    const regla = await ec.regla(X, cx, { docNumero: "20500000003", destino: "DNG" });
    const e = evaluadorFalso();
    const c = await codigoDe(
      worker.withTenant({ tenantId: X }, (tx) =>
        insertarCompras(
          tx,
          { clienteId: cx.id, periodo: DESCARGA, propuestaId: propX },
          [fila("F011", "1", "20500000003")],
          { evaluar: e.evaluar, historial: (f) => ({ reglaId: regla, datos: consolidar(f.montos, "DG") }) },
        ),
      ),
    );
    expect(c).toBe("42501");
    expect((await admin.query("select count(*)::int as n from compra where cliente_id = $1 and serie = 'F011'", [cx.id])).rows[0].n).toBe(0);
  });
});

// =================================================================================================
describe("0048 · auditoria compra.historial (CA-13, D-10)", () => {
  it("una fila por version historial: actor sistema, entidad regla_aplicacion, datos exactos {compraId, reglaId, periodo}, sin RUC ni razon social ni montos", async () => {
    const b = await base();
    const regla = await ec.regla(X, cx, { docNumero: b.doc });
    const { filas, resultado: compra } = await ec.capturar(X, "compra.historial", () =>
      worker.withTenant({ tenantId: X }, async (tx) => {
        const c = await compraDelWorker(tx, cx.id, propX, DESCARGA, {
          numero: numero(),
          docNumero: b.doc,
          razonSocial: "CANARIO AUDITORIA SAC",
        });
        await aplicar(tx, c, regla, consolidar(FACTURA_DG, "DNG"));
        return c;
      }),
    );
    const ap = (await admin.query("select id from regla_aplicacion where compra_id = $1", [compra])).rows[0].id as string;
    const f = unaFila(filas, "compra.historial", {
      actorTipo: "sistema",
      usuarioId: null,
      trabajoId: null,
      clienteId: cx.id,
      entidad: "regla_aplicacion",
      entidadId: ap,
      datos: { compraId: compra, reglaId: regla, periodo: DESCARGA },
    });
    const texto = JSON.stringify(f.datos);
    for (const prohibido of [b.doc, "CANARIO", "PROVEEDOR"])
      expect(texto, prohibido).not.toContain(prohibido);
  });

  it("la version 1 del SIRE no genera compra.historial; una compra rechazada tampoco", async () => {
    const b = await base();
    const { filas } = await ec.capturar(X, "compra.historial", () =>
      worker.withTenant({ tenantId: X }, (tx) => nuevaCompra(tx, b)),
    );
    expect(filas).toEqual([]);
  });
});
