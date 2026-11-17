// Spec 021 · ronda adversarial 3 sobre T25c (0052): `aplicar_reglas_historial(jsonb)` por lotes, la auditoria `compra.historial`
// por sentencia y `interno.auditoria_insertar_lote`. Caja negra (contrato de 0052 y de reglas-lote.spec.ts) y luego blanca
// (0052, packages/db/src/reglas/aplicar.ts, compras/versiones.ts). Frentes: compras repetidas (en el lote y entre lotes, con la
// misma uuid en otro formato), mezcla de clientes, set_config de otro estudio, JSON raro, montos al borde de NUMERIC(14,2) o que
// no cuadran, permisos de las dos funciones nuevas (incluido colgar la captura de una tabla temporal y una tabla temporal
// `nuevas` que intente suplantar la tabla de transicion) y la regla editada o eliminada en paralelo al lote.
// Una prueba marcada `it.fails` es un hallazgo H-021-3-n; las demas quedan como regresion.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { abrirPool, intentarRaw, type ContappDb, type Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import type { Montos } from "./compras-soporte";
import {
  compraDelWorker,
  consolidar,
  datosJson,
  DESCARGA,
  EscenarioReglas,
  FACTURA_DG,
  montos,
  ROLES_APP,
  uuidNuevo,
  type Destino,
} from "./reglas-soporte";

const SQL_LOTE = "select public.aplicar_reglas_historial($1::jsonb) as n";
const SQL_FILA = "select public.aplicar_regla_historial($1, $2, $3::jsonb) as n";
const FIRMA_LOTE = "public.aplicar_reglas_historial(jsonb)";
const FIRMA_INSERTAR_LOTE = "interno.auditoria_insertar_lote(uuid,text,uuid,uuid,text,text,uuid[],uuid[],jsonb[])";

let admin: Pool;
let app: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let propX: string;
let propX2: string;
let propY: string;
let trabajoX: string;
let errSiembra: unknown;

beforeAll(async () => {
  admin = abrirAdmin(6);
  app = abrirPool(2);
  ec = new EscenarioReglas(admin);
  try {
    X = (await ec.estudio()).id;
    Y = (await ec.estudio()).id;
    cx = await ec.cliente(X);
    cx2 = await ec.cliente(X);
    cy = await ec.cliente(Y);
    ux = await ec.usuarioDe(X);
    worker = crearDb("contapp_worker", 3);
    propX = await ec.propuesta(X, cx, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
    propX2 = await ec.propuesta(X, cx2, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
    propY = await ec.propuesta(Y, cy, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
    trabajoX = await ec.trabajo(X, cx, ux);
  } catch (e) {
    errSiembra = e;
  }
}, 60_000);
beforeEach(() => {
  if (errSiembra) throw errSiembra;
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all([worker?.close(), ec?.cerrar()].map((p) => p?.catch(() => undefined)));
  await app?.end();
  await admin?.end();
});

let consecutivo = 0;
const numero = () => String(7000 + ++consecutivo);
const docNuevo = () => `2${String(700000000 + ++consecutivo).padStart(10, "0")}`;

interface Item {
  compra: string;
  regla: string;
  datos: Record<string, string>;
}
const item = (compra: string, regla: string, m: Montos, destino: Destino): Item => ({
  compra,
  regla,
  datos: datosJson(consolidar(m, destino)),
});

async function lote(tx: Tx | PoolClient, items: unknown): Promise<number> {
  const r = await tx.query(SQL_LOTE, [typeof items === "string" ? items : JSON.stringify(items)]);
  return Number(r.rows[0].n);
}

/** `hacer` dentro de un SAVEPOINT que SIEMPRE se revierte y se libera; 'ok' o el SQLSTATE. */
async function enSavepoint(tx: Tx, hacer: () => Promise<unknown>): Promise<string> {
  await tx.query("SAVEPOINT r3");
  try {
    await hacer();
    return "ok";
  } catch (e) {
    const x = e as { code?: string; codigo?: string };
    return String(x.code ?? x.codigo ?? "sin_codigo");
  } finally {
    // RELEASE tras el ROLLBACK TO: lo que siga corre en la transaccion principal (xmin de la compra = su xid), no en r3.
    await tx.query("ROLLBACK TO SAVEPOINT r3");
    await tx.query("RELEASE SAVEPOINT r3");
  }
}

const nuevaCompra = (
  tx: Tx,
  doc: string,
  m: Montos = FACTURA_DG,
  o: { cliente?: ClientePrueba; propuesta?: string; razonSocial?: string } = {},
) =>
  compraDelWorker(tx, (o.cliente ?? cx).id, o.propuesta ?? propX, DESCARGA, {
    numero: numero(),
    docNumero: doc,
    montos: m,
    ...(o.razonSocial === undefined ? {} : { razonSocial: o.razonSocial }),
  });

async function estado(id: string) {
  const r = await admin.query(
    `select (select count(*)::int from compra_version where compra_id = $1) as versiones,
            (select version_vigente from compra where id = $1) as vigente,
            (select count(*)::int from regla_aplicacion where compra_id = $1) as aplicaciones,
            (select count(*)::int from auditoria where accion = 'compra.historial' and datos ->> 'compraId' = $1::text) as auditoria`,
    [id],
  );
  return r.rows[0] as { versiones: number; vigente: number; aplicaciones: number; auditoria: number };
}
const SIN_APLICAR = { versiones: 1, vigente: 1, aplicaciones: 0, auditoria: 0 };
const APLICADA = { versiones: 2, vigente: 2, aplicaciones: 1, auditoria: 1 };

/** Espera a que alguna sesion que ejecuta `aplicar_reglas_historial` quede esperando un candado (como mucho ~5 s). */
async function esperarBloqueo(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const r = await admin.query(
      `select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%aplicar_reglas_historial%' and pid <> pg_backend_pid()`,
    );
    if (r.rows[0].n > 0) return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

// =================================================================================================
describe("ronda 3 · compras repetidas, mezcla de clientes y de estudios", () => {
  it("la misma compra en el lote escrita en mayusculas y minusculas, o repetida en un lote posterior: 42501 sin tocar nada", async () => {
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DNG" });
    const ids = await worker.withTenant({ tenantId: X }, async (tx) => {
      const a = await nuevaCompra(tx, doc);
      const b = await nuevaCompra(tx, doc);
      const c = await nuevaCompra(tx, doc);
      const ia = item(a, regla, FACTURA_DG, "DNG");
      const mayus = { ...ia, compra: a.toUpperCase() };
      const r = {
        mismoLoteFormatos: await enSavepoint(tx, () => lote(tx, [ia, item(b, regla, FACTURA_DG, "DNG"), mayus])),
        // Llaves: un uuid con llaves no tiene la forma de 0048: rechazo.
        conLlaves: await enSavepoint(tx, () => lote(tx, [{ ...ia, compra: `{${a}}` }])),
        primero: await lote(tx, [ia, item(b, regla, FACTURA_DG, "DNG")]),
        entreLotes: await enSavepoint(tx, () => lote(tx, [item(c, regla, FACTURA_DG, "DNG"), mayus])),
      };
      expect(r).toEqual({ mismoLoteFormatos: "42501", conLlaves: "42501", primero: 2, entreLotes: "42501" });
      return { a, b, c };
    });
    expect(await estado(ids.a)).toEqual(APLICADA);
    expect(await estado(ids.b)).toEqual(APLICADA);
    expect(await estado(ids.c), "la valida del lote rechazado").toEqual(SIN_APLICAR);
  });

  it("un lote con compras de dos clientes del estudio (cada una con su regla) y trabajoId: una auditoria por compra, su cliente, actor trabajo, sin canarios", async () => {
    const CANARIO = `CANARIO-T25C-${uuidNuevo()}`;
    const docA = docNuevo();
    const docB = docNuevo();
    const reglaA = await ec.regla(X, cx, { docNumero: docA, destino: "DNG" });
    const reglaB = await ec.regla(X, cx2, { docNumero: docB, destino: "DGNG" });
    const { filas, resultado } = await ec.capturar(X, "compra.historial", () =>
      worker.withTenant({ tenantId: X, trabajoId: trabajoX }, async (tx) => {
        const items: Item[] = [];
        const clientes = new Map<string, string>();
        for (let i = 0; i < 3; i++) {
          const id = await nuevaCompra(tx, docA, FACTURA_DG, { razonSocial: CANARIO });
          clientes.set(id, cx.id);
          items.push(item(id, reglaA, FACTURA_DG, "DNG"));
          const id2 = await nuevaCompra(tx, docB, FACTURA_DG, { cliente: cx2, propuesta: propX2, razonSocial: CANARIO });
          clientes.set(id2, cx2.id);
          items.push(item(id2, reglaB, FACTURA_DG, "DGNG"));
        }
        // La regla de un cliente sobre la compra del otro, mezclada: rechazo del lote entero.
        const cruzado = { ...items[1]!, regla: reglaA };
        expect(await enSavepoint(tx, () => lote(tx, [items[0], cruzado]))).toBe("42501");
        expect(await lote(tx, items)).toBe(6);
        return { items, clientes };
      }),
    );
    expect(filas).toHaveLength(6);
    const ap = await admin.query(
      "select id, compra_id, regla_id from regla_aplicacion where compra_id = any($1::uuid[])",
      [resultado.items.map((i) => i.compra)],
    );
    expect(ap.rows).toHaveLength(6);
    const porCompra = new Map(filas.map((f) => [(f.datos as { compraId: string }).compraId, f]));
    expect(porCompra.size, "una fila por compra").toBe(6);
    for (const a of ap.rows) {
      const f = porCompra.get(a.compra_id as string)!;
      expect(f, a.compra_id).toBeDefined();
      expect({
        actor: f.actor_tipo,
        usuario: f.usuario_id,
        trabajo: f.trabajo_id,
        cliente: f.cliente_id,
        entidad: f.entidad,
        entidadId: f.entidad_id,
        claves: Object.keys(f.datos as object).sort(),
        regla: (f.datos as { reglaId: string }).reglaId,
        periodo: (f.datos as { periodo: string }).periodo,
      }).toEqual({
        actor: "trabajo",
        usuario: ux,
        trabajo: trabajoX,
        cliente: resultado.clientes.get(a.compra_id as string),
        entidad: "regla_aplicacion",
        entidadId: a.id,
        claves: ["compraId", "periodo", "reglaId"],
        regla: a.regla_id,
        periodo: DESCARGA,
      });
      expect(JSON.stringify(f), "canario en la auditoria").not.toContain("CANARIO");
    }
  });

  it("set_config de otro estudio entre la descarga y el lote: 42501; un lote que mezcla compras de dos estudios tambien", async () => {
    const docX = docNuevo();
    const docY = docNuevo();
    const reglaX = await ec.regla(X, cx, { docNumero: docX, destino: "DNG" });
    const reglaY = await ec.regla(Y, cy, { docNumero: docY, destino: "DNG" });
    const r = await worker.withTenant({ tenantId: X }, async (tx) => {
      const compraX = await nuevaCompra(tx, docX);
      const iX = item(compraX, reglaX, FACTURA_DG, "DNG");
      const fijar = (t: string) => tx.query("select set_config('app.tenant_id', $1, true)", [t]);
      const salida = {
        // El contexto pasa a Y: la compra de X no existe para el lote.
        otroEstudio: await enSavepoint(tx, async () => {
          await fijar(Y);
          await lote(tx, [iX]);
        }),
        // En Y el worker crea una compra de Y con su regla y mezcla la de X: rechazo del lote entero.
        mezcla: await enSavepoint(tx, async () => {
          await fijar(Y);
          const compraY = await nuevaCompra(tx, docY, FACTURA_DG, { cliente: cy, propuesta: propY });
          await lote(tx, [item(compraY, reglaY, FACTURA_DG, "DNG"), iX]);
        }),
        // Contexto vacio o que no es uuid: nunca aplica.
        vacio: await enSavepoint(tx, async () => {
          await fijar("");
          await lote(tx, [iX]);
        }),
        basura: await enSavepoint(tx, async () => {
          await fijar("no-es-uuid");
          await lote(tx, [iX]);
        }),
      };
      return { salida, compraX };
    });
    expect(r.salida.otroEstudio).toBe("42501");
    expect(r.salida.mezcla).toBe("42501");
    expect(r.salida.vacio).toBe("42501");
    expect(r.salida.basura).not.toBe("ok");
    expect(await estado(r.compraX)).toEqual(SIN_APLICAR);
  });
});

// =================================================================================================
describe("ronda 3 · JSON raro y montos al borde", () => {
  it("cadenas de monto raras, claves con otra caja o espacios, arreglos anidados: 42501 (nunca otro error ni ok)", async () => {
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DNG" });
    const r = await worker.withTenant({ tenantId: X }, async (tx) => {
      const compra = await nuevaCompra(tx, doc);
      const ok = item(compra, regla, FACTURA_DG, "DNG");
      const RARAS = [
        "1180.00\n", " 1180.00", "1180.00 ", "+1180.00", "1180.", "１１８０.00", "١١٨٠.00", "1,180.00", "1_180.00",
        "0x49C", "1.18e3", "Infinity", "NaN", "", "-", "1180.000", "0".repeat(20000),
      ];
      const salida: Record<string, string> = {};
      for (const v of RARAS) {
        salida[JSON.stringify(v).slice(0, 24)] = await enSavepoint(tx, () => lote(tx, [{ ...ok, datos: { ...ok.datos, total: v } }]));
      }
      const { compra: _c, ...sinCompra } = ok;
      const FORMAS: [string, unknown][] = [
        ["Compra con mayuscula", [{ ...sinCompra, Compra: ok.compra }]],
        ["clave con espacio", [{ ...sinCompra, "compra ": ok.compra }]],
        ["datos con clave en mayusculas", [{ ...ok, datos: { ...Object.fromEntries(Object.entries(ok.datos).filter(([k]) => k !== "total")), TOTAL: ok.datos.total } }]],
        ["arreglo anidado", [[ok]]],
        ["datos como cadena JSON", [{ ...ok, datos: JSON.stringify(ok.datos) }]],
        ["compra como numero", [{ ...ok, compra: 1 }]],
        ["monto anidado", [{ ...ok, datos: { ...ok.datos, total: { v: "1180.00" } } }]],
      ];
      for (const [n, p] of FORMAS) salida[n] = await enSavepoint(tx, () => lote(tx, p));
      // Clave repetida en el texto JSON: jsonb se queda con la ultima. La primera (ajena) no cuela.
      const crudo = `[{"compra":"${uuidNuevo()}","regla":"${regla}","datos":${JSON.stringify(ok.datos)},"compra":"${compra}"}]`;
      salida.duplicadaUltimaValida = await enSavepoint(tx, () => lote(tx, crudo));
      const crudo2 = `[{"compra":"${compra}","regla":"${regla}","datos":${JSON.stringify(ok.datos)},"compra":"${uuidNuevo()}"}]`;
      salida.duplicadaUltimaAjena = await enSavepoint(tx, () => lote(tx, crudo2));
      return { salida, compra };
    });
    const { duplicadaUltimaValida, ...rechazos } = r.salida;
    for (const [k, v] of Object.entries(rechazos)) expect(v, k).toBe("42501");
    expect(duplicadaUltimaValida, "jsonb: la ultima clave manda").toBe("ok");
    expect(await estado(r.compra)).toEqual(SIN_APLICAR);
  });

  it("consolidacion que no cabe en NUMERIC(14,2) (BI o IGV) y versiones 1 que no cuadran: el lote hace lo mismo que la fila", async () => {
    const CASOS: [string, Montos][] = [
      ["BI 999999999999.99 + 0.01", montos({ biDg: "999999999999.99", biDgng: "0.01", total: "999999999999.99" })],
      ["BI negativo al borde", montos({ biDg: "-999999999999.99", biDgng: "-0.01", total: "-999999999999.99" })],
      ["IGV que no cabe", montos({ biDg: "1.00", igvDg: "999999999999.99", igvDgng: "0.01", total: "1.00" })],
      ["IGV que no cuadra y total que no suma", montos({ biDg: "100.00", igvDg: "50.00", noGravado: "3.00", total: "7.00" })],
      ["BI que se anulan (100 y -100) con IGV", montos({ biDg: "100.00", biDng: "-100.00", igvDg: "18.00", total: "18.00" })],
    ];
    const r = await worker.withTenant({ tenantId: X }, async (tx) => {
      const salida: Record<string, { lote: string; fila: string; v2Lote?: unknown; v2Fila?: unknown }> = {};
      for (const [nombre, m] of CASOS) {
        const doc = docNuevo();
        const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DGNG" });
        const compra = await nuevaCompra(tx, doc, m);
        const i = item(compra, regla, m, "DGNG");
        // El tope del formato: 13 cifras enteras no pasan la forma; recortado a 12 no es la consolidacion.
        const recortado = {
          ...i,
          datos: Object.fromEntries(Object.entries(i.datos).map(([k, v]) => [k, v.replace(/^(-?)1000000000000\.00$/, "$1999999999999.99")])),
        };
        const v2 = async () =>
          (await tx.query(
            `select bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper, otros_tributos, total, accion
               from compra_version where compra_id = $1 and n = 2`,
            [compra],
          )).rows[0];
        const s: { lote: string; fila: string; recortado: string; v2Lote?: unknown; v2Fila?: unknown } = {
          lote: "",
          fila: "",
          recortado: "",
        };
        s.lote = await enSavepoint(tx, async () => {
          await lote(tx, [i]);
          s.v2Lote = await v2();
        });
        s.fila = await enSavepoint(tx, async () => {
          await tx.query(SQL_FILA, [i.compra, i.regla, JSON.stringify(i.datos)]);
          s.v2Fila = await v2();
        });
        s.recortado = await enSavepoint(tx, () => lote(tx, [recortado]));
        salida[nombre] = s;
      }
      return salida;
    });
    for (const nombre of ["BI 999999999999.99 + 0.01", "BI negativo al borde", "IGV que no cabe", "BI que se anulan (100 y -100) con IGV"]) {
      expect(r[nombre], nombre).toMatchObject({ lote: "42501", fila: "42501", recortado: "42501" });
    }
    const nc = r["IGV que no cuadra y total que no suma"]!;
    expect(nc).toMatchObject({ lote: "ok", fila: "ok" });
    expect(nc.v2Lote).toEqual(nc.v2Fila);
    expect(nc.v2Lote).toMatchObject({ bi_dgng: "100.00", igv_dgng: "50.00", no_gravado: "3.00", total: "7.00", accion: "historial" });
  });
});

// =================================================================================================
describe("ronda 3 · permisos de las dos funciones nuevas y la captura por sentencia", () => {
  it("nadie mas ejecuta ni puede volverse dueño: el lote solo el worker; el INSERT por lote solo el migrador; datos falsificados 42501 desde cada rol", async () => {
    const ejecutan = async (firma: string) =>
      (
        await admin.query(
          `select coalesce(array_agg(r.rolname::text order by r.rolname), '{}') as roles from pg_roles r
            where not r.rolsuper and has_function_privilege(r.oid, $1::regprocedure, 'EXECUTE')`,
          [firma],
        )
      ).rows[0].roles as string[];
    expect(await ejecutan(FIRMA_LOTE)).toEqual(["contapp_migrator", "contapp_worker"]);
    expect(await ejecutan(FIRMA_INSERTAR_LOTE)).toEqual(["contapp_migrator", "contapp_registrador"]);
    // Ningun rol (no superusuario) puede hacer SET ROLE a los dueños.
    const setRole = await admin.query(
      `select r.rolname::text as rol, d.rolname::text as dueno from pg_roles r, pg_roles d
        where not r.rolsuper and d.rolname in ('contapp_migrator', 'contapp_registrador') and r.oid <> d.oid
          and pg_has_role(r.oid, d.oid, 'SET')`,
    );
    expect(setRole.rows).toEqual([]);
    const forjado = `select interno.auditoria_insertar_lote($1::uuid, 'usuario', $2::uuid, null, 'compra.historial', 'regla_aplicacion',
        array[$3::uuid], array[$4::uuid], array['{"compraId":"x"}'::jsonb])`;
    const valores = [X, ux, cx.id, uuidNuevo()];
    const codigos: Record<string, string> = {};
    // Con el usuario de la app (sin SET ROLE) y con cada rol al que puede cambiar.
    for (const rol of [null, "contapp_backend", "contapp_worker"]) {
      const x = await intentarRaw(app, rol, forjado, valores);
      codigos[`app:${rol ?? "login"}`] = x.ok ? "ok" : x.code;
      const y = await intentarRaw(app, rol, SQL_LOTE, ["[]"]);
      codigos[`app-lote:${rol ?? "login"}`] = y.ok ? "ok" : y.code;
    }
    // Y desde cada rol de la app, con SET ROLE desde el superusuario.
    for (const rol of ROLES_APP.filter((r) => r !== "contapp_registrador")) {
      const x = await intentarRaw(admin, rol, forjado, valores);
      codigos[`rol:${rol}`] = x.ok ? "ok" : x.code;
    }
    expect(Object.entries(codigos).filter(([k, v]) => v !== "42501" && k !== "app-lote:contapp_worker")).toEqual([]);
    // El worker si entra a la funcion: el lote vacio lo rechaza ella misma.
    expect(codigos["app-lote:contapp_worker"]).toBe("42501");
    const n = await admin.query("select count(*)::int as n from auditoria where datos ->> 'compraId' = 'x'");
    expect(n.rows[0].n).toBe(0);
  });

  it("la captura no se puede colgar de una tabla temporal, y una tabla temporal `nuevas` no suplanta la tabla de transicion", async () => {
    const colgar = [
      "create temp table ra_falsa (id uuid, tenant_id uuid, compra_id uuid, regla_id uuid, periodo text) on commit drop",
      `create trigger ra_falsa_aud after insert on ra_falsa referencing new table as nuevas
         for each statement execute function public.auditoria_capturar_regla_aplicacion()`,
      `insert into ra_falsa values (gen_random_uuid(), '${X}', gen_random_uuid(), gen_random_uuid(), '${DESCARGA}')`,
    ];
    for (const rol of [null, "contapp_backend", "contapp_worker"]) {
      const c = await app.connect();
      let codigo = "ok";
      try {
        await c.query("BEGIN");
        if (rol) await c.query(`SET LOCAL ROLE ${rol}`);
        for (const s of colgar) await c.query(s);
      } catch (e) {
        codigo = String((e as { code?: string }).code);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
      expect(codigo, `colgar la captura como ${rol ?? "login"}`).toBe("42501");
    }

    // El worker, con una tabla temporal `nuevas` con una fila forjada, aplica un lote valido: solo su fila se audita.
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DNG" });
    const forjada = uuidNuevo();
    const { filas, resultado } = await ec.capturar(X, "compra.historial", () =>
      worker.withTenant({ tenantId: X }, async (tx) => {
        const temporal = await enSavepoint(tx, () =>
          tx.query("create temp table nuevas (id uuid, tenant_id uuid, compra_id uuid, regla_id uuid, periodo text) on commit drop"),
        );
        if (temporal === "ok") {
          await tx.query("create temp table nuevas (id uuid, tenant_id uuid, compra_id uuid, regla_id uuid, periodo text) on commit drop");
          await tx.query("insert into nuevas values ($1, $2, $1, $3, $4)", [forjada, X, regla, DESCARGA]);
        }
        const compra = await nuevaCompra(tx, doc);
        expect(await lote(tx, [item(compra, regla, FACTURA_DG, "DNG")])).toBe(1);
        return compra;
      }),
    );
    expect(filas.map((f) => (f.datos as { compraId: string }).compraId)).toEqual([resultado]);
    expect(filas.some((f) => JSON.stringify(f).includes(forjada))).toBe(false);
  });
});

// =================================================================================================
describe("ronda 3 · la regla editada o eliminada en paralelo al lote", () => {
  it("regla eliminada, con otro destino o desactivada por otra transaccion aun abierta: el lote espera y, al confirmarse, rechaza (42501) sin aplicar", async () => {
    const CAMBIOS = [
      ["eliminada", "update regla_aprendida set eliminada_en = now(), eliminada_por = creada_por where id = $1"],
      ["con el destino cambiado", "update regla_aprendida set destino = 'DGNG', version = version + 1 where id = $1"],
      ["desactivada", "update regla_aprendida set activa = false, version = version + 1 where id = $1"],
    ] as const;
    for (const [nombre, cambio] of CAMBIOS) {
      const doc = docNuevo();
      const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DNG" });
      const otra = await admin.connect();
      let compra = "";
      try {
        await otra.query("BEGIN");
        await otra.query(cambio, [regla]);
        const enCurso = worker.withTenant({ tenantId: X }, async (tx) => {
          compra = await nuevaCompra(tx, doc);
          await tx.query("SET LOCAL lock_timeout = '8s'");
          return enSavepoint(tx, () => lote(tx, [item(compra, regla, FACTURA_DG, "DNG")]));
        });
        const bloqueado = await esperarBloqueo();
        await otra.query("COMMIT");
        const r = await enCurso;
        expect({ bloqueado, r }, nombre).toEqual({ bloqueado: true, r: "42501" });
      } finally {
        await otra.query("ROLLBACK").catch(() => undefined);
        otra.release();
      }
      expect(await estado(compra), nombre).toEqual(SIN_APLICAR);
    }
  }, 60_000);

  it("con reglas_historial_vigentes leida en la descarga, editar o eliminar la regla espera a que la descarga termine; el lote aplica", async () => {
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DNG" });
    const otra = await admin.connect();
    try {
      const compra = await worker.withTenant({ tenantId: X }, async (tx) => {
        const v = await tx.query("select regla_id from public.reglas_historial_vigentes($1, $2)", [cx.id, DESCARGA]);
        expect(v.rows.map((x) => x.regla_id)).toContain(regla);
        const compra = await nuevaCompra(tx, doc);
        for (const s of [
          "update regla_aprendida set eliminada_en = now(), eliminada_por = creada_por where id = $1",
          "update regla_aprendida set destino = 'DG', version = version + 1 where id = $1",
        ]) {
          await otra.query("BEGIN");
          await otra.query("SET LOCAL lock_timeout = '300ms'");
          const c = await otra.query(s, [regla]).then(
            () => "ok",
            (e: { code?: string }) => String(e.code),
          );
          await otra.query("ROLLBACK");
          expect(c, s).toBe("55P03");
        }
        expect(await lote(tx, [item(compra, regla, FACTURA_DG, "DNG")])).toBe(1);
        return compra;
      });
      expect(await estado(compra)).toEqual(APLICADA);
    } finally {
      await otra.query("ROLLBACK").catch(() => undefined);
      otra.release();
    }
  });
});
