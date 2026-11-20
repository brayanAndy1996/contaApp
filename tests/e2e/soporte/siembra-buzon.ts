// Siembra del buzón por SQL (spec 023, T22). Misma regla que `siembra.ts`: solo opera sobre `contapp_e2e` con la
// conexión de migraciones, y cada prueba usa su propio estudio y cliente.
import { Pool } from "pg";
import { BD_E2E } from "./pila/entorno.js";

/**
 * Deja al cliente como ya sincronizado (`sincronizado_en` = ahora). Así todo crítico nuevo se avisa sin importar su
 * fecha (CA-6): el fixture `fixtures/sol/buzon/20700000002.json` tiene fechas fijas de octubre de 2026 y, sin esto,
 * la primera sincronización (solo avisa los críticos de los últimos 30 días) haría que la prueba dependiera del día
 * en que corre.
 */
export async function marcarBuzonSincronizado(
  tenantId: string,
  clienteId: string,
): Promise<void> {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (url === undefined || new URL(url).pathname !== `/${BD_E2E}`) {
    throw new Error(`La siembra del buzón solo opera sobre ${BD_E2E}.`);
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      `insert into buzon_estado_cliente (tenant_id, cliente_id, sincronizado_en)
       values ($1, $2, now())
       on conflict (tenant_id, cliente_id) do update set sincronizado_en = excluded.sincronizado_en`,
      [tenantId, clienteId],
    );
  } finally {
    await pool.end();
  }
}
