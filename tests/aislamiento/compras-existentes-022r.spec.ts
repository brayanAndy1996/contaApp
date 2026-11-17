// Spec 022 · RP-2, defecto intermitente de CA-7 (CI run 43948801592: primera lectura de 20.000 compras en 32,4 s; T5: 1 de 40 en 42 s).
//   Causa: ANALYZE (o autovacuum) que ve `compra_version` sin filas vivas (las de la carga anterior ya borradas, o las de la descarga
//   en curso aún sin confirmar) deja `reltuples = 0` con `relpages > 0`. Con eso, tras una carga grande sin ANALYZE, el planificador
//   estima 1 fila por estudio y la búsqueda por compra del lateral empata entre la única (tenant_id, compra_id, n) y
//   `compra_version_operacion_idx` (tenant_id, operacion_id): elige esta, que trae TODAS las versiones del estudio en cada vuelta
//   del nested loop (O(n²): 20.000 × 20.000). Corrección (0053): el índice de operación es parcial (`operacion_id is not null`), así
//   que una consulta sin `operacion_id = …` no puede usarlo y la única queda como el solo acceso razonable, con o sin estadísticas.
//   R-1  estructura: ningún índice de compra_version distinto de la única sirve una búsqueda sin `operacion_id`.
//   R-2  tiempo: reproduce esas estadísticas (carga, borrado, ANALYZE con 0 vivas, carga de 20.000 sin ANALYZE ni autovacuum) y
//        exige la primera lectura ≤ 1,0 s. Antes de 0053: ~29 s. La aserción de tiempo se salta bajo cobertura (D-8, como CA-7).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { EscenarioCompras } from "./compras-soporte";

const leerExistentesCompras = (tx: Tx, c: string, p: string) =>
  exportado<(tx: Tx, c: string, p: string) => Promise<unknown[]>>(
    "leerExistentesCompras",
  )(tx, c, p);

const BAJO_COBERTURA = process.env.CONTAPP_COBERTURA === "1";
const TABLAS = ["compra", "compra_version"] as const;

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

/** `n` compras SIRE del periodo con su versión 1 (1 de cada 20 descartada), en una sola transacción y sin ANALYZE. */
async function cargar(
  e: EscenarioCompras,
  tenantId: string,
  c: ClientePrueba,
  n: number,
  periodo: string,
): Promise<void> {
  const prop = await e.propuesta(tenantId, c, {
    periodo,
    libro: "compras",
    nuevas: n,
  });
  // Registra el tenant para la limpieza de las tablas de compras.
  await e.compra(tenantId, c, {
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
    await cx.query("COMMIT");
  } catch (e) {
    await cx.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    cx.release();
  }
}

describe("RP-2 · leerExistentesCompras no depende de las estadísticas", () => {
  it("R-1 · solo la única (tenant_id, compra_id, n) sirve una búsqueda de compra_version sin operacion_id", async () => {
    const r = await admin.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'compra_version' order by indexname`,
    );
    const nombres = r.rows.map((f) => f.indexname);
    expect(nombres).toContain("compra_version_compra_n_unique");
    expect(nombres).toContain("compra_version_operacion_idx");
    for (const f of r.rows) {
      if (
        f.indexname === "compra_version_compra_n_unique" ||
        f.indexname === "compra_version_pkey"
      )
        continue;
      // Cualquier otro índice debe ser parcial y exigir operacion_id: así la búsqueda por compra no puede elegirlo.
      expect(f.indexdef, f.indexname).toMatch(
        /WHERE \(operacion_id IS NOT NULL\)$/,
      );
    }
  });

  it("R-2 · 20.000 compras tras un ANALYZE que vio 0 filas vivas: primera lectura ≤ 1,0 s", async () => {
    const P = "202603";
    for (const t of TABLAS)
      await admin.query(`alter table ${t} set (autovacuum_enabled = false)`);
    try {
      // 1. Una carga anterior que ya se borró: solo deja páginas con filas muertas.
      const previo = new EscenarioCompras(admin);
      const Y = (await previo.estudio()).id;
      await cargar(previo, Y, await previo.cliente(Y), 2_000, P);
      await previo.limpiar();
      // 2. ANALYZE en ese momento (lo que hace autovacuum tras el borrado): reltuples ≈ 0, relpages > 0.
      for (const t of TABLAS) await admin.query(`analyze ${t}`);
      const antes = await admin.query(
        `select relname, reltuples, relpages from pg_class where relname = any($1::text[]) order by relname`,
        [TABLAS],
      );
      // 3. La descarga grande, sin ANALYZE ni autovacuum entre la carga y la primera lectura.
      const X = (await ec.estudio()).id;
      const c = await ec.cliente(X);
      await cargar(ec, X, c, 20_000, P);

      let filas = 0;
      const t0 = performance.now();
      await backend.withTenant({ tenantId: X }, async (tx) => {
        filas = (await leerExistentesCompras(tx, c.id, P)).length;
      });
      const primera = performance.now() - t0;

      console.info(
        `RP-2 R-2: 20.000 primera ${primera.toFixed(0)} ms · estadísticas tras el ANALYZE ${JSON.stringify(antes.rows)}${BAJO_COBERTURA ? " (bajo cobertura: no se compara)" : ""}`,
      );
      expect(filas).toBe(20_000 - 1_000 + 1);
      if (BAJO_COBERTURA) return;
      expect(primera).toBeLessThanOrEqual(1_000);
    } finally {
      for (const t of TABLAS) {
        await admin.query(`alter table ${t} reset (autovacuum_enabled)`);
        // Deja estadísticas reales para las suites que siguen.
        await admin.query(`analyze ${t}`);
      }
    }
  }, 300_000);
});
