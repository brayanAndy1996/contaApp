// Siembra por SQL de ventas del SIRE (spec 018, T8): lo que la descarga mock no puede dar, como una venta
// descuadrada (total 119.00 sobre 118.00). Misma conexión de migraciones que `siembra.ts` y misma regla: solo
// opera sobre `contapp_e2e`. Archivo aparte para no tocar `siembra.ts`, que comparten todos los flujos.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { BD_E2E } from "./pila/entorno.js";
import type { Cliente } from "./siembra.js";

export interface FilaVentaSql {
  readonly tipo: string;
  readonly serie: string;
  readonly numero: number;
  readonly fecha: string;
  readonly baseGravada: string;
  readonly igv: string;
  readonly total: string;
}

/** Boleta que cuadra: 100.00 + 18.00 = 118.00. */
export const boleta = (serie: string, numero: number): FilaVentaSql => ({
  tipo: "03",
  serie,
  numero,
  fecha: "2026-10-05",
  baseGravada: "100.00",
  igv: "18.00",
  total: "118.00",
});

/** Boleta descuadrada: 100.00 + 18.00 pero total 119.00. El servidor la marca «No cuadra» y el previo la bloquea. */
export const descuadrada = (serie: string, numero: number): FilaVentaSql => ({
  ...boleta(serie, numero),
  total: "119.00",
});

/** Inserta una propuesta de ventas del Dueño del cliente y las `filas` como ventas de origen `sire`. */
export async function sembrarVentas(
  cliente: Cliente,
  periodo: string,
  filas: readonly FilaVentaSql[],
): Promise<void> {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (url === undefined || new URL(url).pathname !== `/${BD_E2E}`) {
    throw new Error(`La siembra de ventas solo opera sobre ${BD_E2E}.`);
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const d = await c.query<{ usuario_id: string }>(
        `select usuario_id from membresia where tenant_id = $1 and rol = 'dueno' limit 1`,
        [cliente.tenantId],
      );
      const usuarioId = d.rows[0]?.usuario_id;
      if (usuarioId === undefined) throw new Error("Estudio sin Dueño.");
      const p = await c.query<{ id: string }>(
        `insert into propuesta (tenant_id, cliente_id, periodo, libro, fuente, hash, filas_recibidas,
                                filas_nuevas, filas_iguales, filas_distintas, usuario_id)
         values ($1, $2, $3, 'ventas', 'api', $4, $5, $5, 0, 0, $6) returning id`,
        [
          cliente.tenantId,
          cliente.id,
          periodo,
          randomUUID().replaceAll("-", "").repeat(2),
          filas.length,
          usuarioId,
        ],
      );
      const propuestaId = p.rows[0]?.id;
      if (propuestaId === undefined)
        throw new Error("No se creó la propuesta.");
      for (const f of filas) {
        await c.query(
          `insert into venta (tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero,
                              numero_n, fecha, tipo_doc_contraparte, doc_contraparte, moneda, base_gravada, igv,
                              exonerada, inafecta, isc, icbper, otros, total)
           values ($1, $2, $3, $4, 'sire', $5, $6, $7, $8, $9, $10, '0', '-', 'PEN', $11, $12, 0, 0, 0, 0, 0, $13)`,
          [
            cliente.tenantId,
            cliente.id,
            periodo,
            propuestaId,
            `${f.tipo}|${f.serie}|${f.numero}`,
            f.tipo,
            f.serie,
            String(f.numero),
            f.numero,
            f.fecha,
            f.baseGravada,
            f.igv,
            f.total,
          ],
        );
      }
      await c.query("commit");
    } catch (error) {
      await c.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
}
