// Spec 022 · T5 (RP-2, CA-6, CA-7): `leerExistentesCompras` sin O(n²) y con el mismo resultado de siempre.
//   CA-6  equivalencia: la consulta anterior (join plano sobre UNION_ORIGINAL) queda aquí como oráculo, solo en la prueba, y se
//         compara fila a fila (mismo orden `clave, id`, mismos `campos`, versión 1 y no la vigente, descartadas fuera) sobre un
//         periodo con SIRE, agregadas, excluidas, descartadas, varias versiones y USD.
//   CA-7  tiempo: 20.000 compras recién cargadas SIN `ANALYZE` (el arnés no lo ejecuta y el autovacuum sigue activo). El plan lento
//         aparece solo en la primera lectura tras la carga (T1: 65 s; luego 134 ms cuando autovacuum calcula estadísticas), así
//         que se mide esa primera lectura aparte; la mediana de 3 por sí sola la esconde. Objetivos: primera lectura y mediana
//         de 3 ≤ 1,0 s, y t(20.000) ≤ 5 × t(5.000). La aserción de tiempo se salta bajo cobertura (D-8).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { EscenarioCompras, montos, PERIODO } from "./compras-soporte";

interface Existente {
  clave: string;
  origen: "sire" | "manual";
  campos: Record<string, string>;
}
const leerExistentesCompras = (tx: Tx, c: string, p: string) =>
  exportado<(tx: Tx, c: string, p: string) => Promise<Existente[]>>(
    "leerExistentesCompras",
  )(tx, c, p);

const BAJO_COBERTURA = process.env.CONTAPP_COBERTURA === "1";

// Oráculo: el cuerpo de SQL_EXISTENTES antes de la spec 022 (join plano con UNION_ORIGINAL).
const SQL_EXISTENTES_ANTERIOR = `select c.clave, c.origen, to_char(c.fecha, 'YYYY-MM-DD') as fecha, c.moneda,
    coalesce(c.tipo_cambio::text, '') as tipo_cambio, c.doc_tipo, c.doc_numero,
    v.bi_dg::text as bi_dg, v.igv_dg::text as igv_dg, v.bi_dgng::text as bi_dgng, v.igv_dgng::text as igv_dgng,
    v.bi_dng::text as bi_dng, v.igv_dng::text as igv_dng, v.no_gravado::text as no_gravado, v.isc::text as isc,
    v.icbper::text as icbper, v.otros_tributos::text as otros_tributos, v.total::text as total
  from compra c join compra_version v on v.tenant_id = c.tenant_id and v.compra_id = c.id and v.n = 1
  where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null
  order by c.clave, c.id`;

async function oraculo(
  tx: Tx,
  clienteId: string,
  periodo: string,
): Promise<Existente[]> {
  const r = await tx.query(SQL_EXISTENTES_ANTERIOR, [clienteId, periodo]);
  return (r.rows as Record<string, string>[]).map((f) => ({
    clave: f.clave!,
    origen: f.origen === "agregada" ? "manual" : "sire",
    campos: {
      fecha: f.fecha!,
      moneda: f.moneda!,
      tipoCambio: f.tipo_cambio!,
      docTipo: f.doc_tipo!,
      docNumero: f.doc_numero!,
      biDg: f.bi_dg!,
      igvDg: f.igv_dg!,
      biDgng: f.bi_dgng!,
      igvDgng: f.igv_dgng!,
      biDng: f.bi_dng!,
      igvDng: f.igv_dng!,
      noGravado: f.no_gravado!,
      isc: f.isc!,
      icbper: f.icbper!,
      otrosTributos: f.otros_tributos!,
      total: f.total!,
    },
  }));
}

let admin: Pool;
let ec: EscenarioCompras;
let backend: ContappDb;

beforeAll(async () => {
  admin = abrirAdmin(4);
  ec = new EscenarioCompras(admin);
  backend = crearDb("contapp_backend", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await backend?.close().catch(() => undefined);
  await admin?.end();
});

const como = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  backend.withTenant({ tenantId }, fn);

describe("CA-6 · equivalencia con la consulta anterior", () => {
  it("devuelve lo mismo y en el mismo orden sobre SIRE, agregadas, excluidas, descartadas, varias versiones y USD", async () => {
    const X = (await ec.estudio()).id;
    const c = await ec.cliente(X);
    const prop = await ec.propuesta(X, c, { libro: "compras", nuevas: 1 });
    const base = { propuestaId: prop };
    const sire = await ec.compra(X, c, {
      ...base,
      serie: "F001",
      numero: "1",
      montos: montos({ biDg: "1000.00", igvDg: "180.00" }),
    });
    // Corregida dos veces: los campos salen de la versión 1, no de la vigente.
    const corregida = await ec.compra(X, c, {
      ...base,
      serie: "F001",
      numero: "2",
      montos: montos({ biDg: "500.00", igvDg: "90.00" }),
    });
    await ec.version(X, corregida.id, 2, { montos: { biDg: "999.00" } });
    await ec.version(X, corregida.id, 3, { montos: { biDg: "777.00" } });
    const excluida = await ec.compra(X, c, {
      ...base,
      serie: "F001",
      numero: "3",
    });
    await ec.version(X, excluida.id, 2, {
      excluida: true,
      motivo: "no corresponde",
      accion: "excluir",
    });
    const descartada = await ec.compra(X, c, {
      origen: "agregada",
      serie: "F001",
      numero: "4",
    });
    await admin.query("update compra set descartada_en = now() where id = $1", [
      descartada.id,
    ]);
    const agregada = await ec.compra(X, c, {
      origen: "agregada",
      serie: "F009",
      numero: "5",
      montos: montos({ biDng: "50.00" }),
    });
    const usd = await ec.compra(X, c, {
      ...base,
      serie: "F001",
      numero: "6",
      moneda: "USD",
      tipoCambio: "3.742",
      montos: montos({ biDg: "100.00", igvDg: "18.00" }),
    });
    // Otro periodo y otro cliente: no deben salir.
    await ec.compra(X, c, {
      ...base,
      serie: "F001",
      numero: "7",
      periodo: "202609",
    });
    const c2 = await ec.cliente(X);
    await ec.compra(X, c2, { origen: "agregada", serie: "F001", numero: "8" });

    const [nuevo, anterior] = await como(X, async (tx) => [
      await leerExistentesCompras(tx, c.id, PERIODO),
      await oraculo(tx, c.id, PERIODO),
    ]);

    expect(anterior).toHaveLength(5); // sire, corregida, excluida, agregada, usd
    expect(nuevo).toEqual(anterior);
    const porClave = new Map(nuevo.map((e) => [e.clave, e]));
    expect(porClave.get(corregida.clave)?.campos.biDg).toBe("500.00");
    expect(porClave.get(agregada.clave)?.origen).toBe("manual");
    expect(porClave.get(usd.clave)?.campos.tipoCambio).toBe("3.742");
    expect(porClave.has(descartada.clave)).toBe(false);
    expect(porClave.has(excluida.clave)).toBe(true);
    expect(porClave.has(sire.clave)).toBe(true);
  });
});

/**
 * Carga masiva de `n` compras SIRE en un periodo (versión 1 en todas; una de cada diez con versión 2 y una de cada veinte con
 * excluida/descartada) con la conexión administrativa y sin ANALYZE. Registra el tenant para que `limpiar()` lo borre.
 */
async function cargar(
  tenantId: string,
  c: ClientePrueba,
  n: number,
  periodo: string,
): Promise<void> {
  const prop = await ec.propuesta(tenantId, c, {
    periodo,
    libro: "compras",
    nuevas: n,
  });
  // `ec.compra` registra el tenant para la limpieza de las tablas de compras; se siembra una sola para eso.
  await ec.compra(tenantId, c, {
    periodo,
    propuestaId: prop,
    serie: "F999",
    numero: "999999",
  });
  const cx = await admin.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(
      `insert into compra (tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
                           razon_social, fecha, moneda, tipo_cambio, origen, version_vigente, descartada_en)
       select $1, $2, $3, $4, '01|F001|' || i || '|6|20100070970', '01', 'F001', i::text, '6', '20100070970',
              'PROVEEDOR SINTETICO SAC', date '2026-10-05', 'PEN', null, 'sire', 1,
              case when i % 20 = 0 then now() else null end
         from generate_series(1, $5::int) i`,
      [tenantId, c.id, periodo, prop, n],
    );
    await cx.query(
      `insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc,
                                   icbper, otros_tributos, total, accion)
       select tenant_id, id, 1, 1000, 180, 0, 0, 0, 0, 0, 0, 0, 0, 1180, 'original'
         from compra where tenant_id = $1 and cliente_id = $2 and periodo = $3 and clave like '01|F001|%'`,
      [tenantId, c.id, periodo],
    );
    await cx.query(
      `insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc,
                                   icbper, otros_tributos, total, accion)
       select tenant_id, id, 2, 900, 162, 0, 0, 0, 0, 0, 0, 0, 0, 1062, 'editar'
         from compra where tenant_id = $1 and cliente_id = $2 and periodo = $3 and clave like '01|F001|%'
          and substring(clave from '^01\\|F001\\|([0-9]+)')::int % 10 = 0`,
      [tenantId, c.id, periodo],
    );
    await cx.query(
      `update compra set version_vigente = 2
        where tenant_id = $1 and cliente_id = $2 and periodo = $3 and clave like '01|F001|%'
          and substring(clave from '^01\\|F001\\|([0-9]+)')::int % 10 = 0`,
      [tenantId, c.id, periodo],
    );
    await cx.query("COMMIT");
  } catch (e) {
    await cx.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    cx.release();
  }
}

const ms = async (fn: () => Promise<unknown>): Promise<number> => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};

interface Medida {
  primera: number;
  mediana: number;
  filas: number;
}
/** Primera lectura tras la carga (la del plan sin estadísticas) y mediana de 3 lecturas (las dos siguientes más la primera). */
async function medir(
  tenantId: string,
  clienteId: string,
  periodo: string,
): Promise<Medida> {
  let filas = 0;
  const lectura = () =>
    como(tenantId, async (tx) => {
      filas = (await leerExistentesCompras(tx, clienteId, periodo)).length;
    });
  const m = [await ms(lectura)];
  const primera = m[0]!;
  m.push(await ms(lectura), await ms(lectura));
  m.sort((a, b) => a - b);
  return { primera, mediana: m[1]!, filas };
}

describe("CA-7 · tiempo de la primera lectura tras la carga, sin ANALYZE", () => {
  it("20.000 compras: primera lectura y mediana de 3 ≤ 1,0 s, y t(20.000) ≤ 5 × t(5.000)", async () => {
    const P5 = "202601";
    const P20 = "202602";
    const X = (await ec.estudio()).id;
    const c = await ec.cliente(X);

    await cargar(X, c, 5_000, P5);
    const pequeno = await medir(X, c.id, P5);
    await cargar(X, c, 20_000, P20);
    const grande = await medir(X, c.id, P20);

    // 5.000 y 20.000 menos 1 de cada 20 descartadas, más la sembrada para el registro de limpieza.
    expect(pequeno.filas).toBe(5_000 - 250 + 1);
    expect(grande.filas).toBe(20_000 - 1_000 + 1);

    const razon = grande.primera / pequeno.primera;
    console.info(
      `CA-6/7 RP-2: 5.000 primera ${pequeno.primera.toFixed(0)} ms (mediana ${pequeno.mediana.toFixed(0)}) · 20.000 primera ${grande.primera.toFixed(0)} ms (mediana ${grande.mediana.toFixed(0)}) · razón de primeras ${razon.toFixed(2)}${BAJO_COBERTURA ? " (bajo cobertura: no se compara)" : ""}`,
    );
    if (BAJO_COBERTURA) return;
    expect(grande.primera).toBeLessThanOrEqual(1_000);
    expect(grande.mediana).toBeLessThanOrEqual(1_000);
    expect(razon).toBeLessThanOrEqual(5);
  }, 300_000);
});
