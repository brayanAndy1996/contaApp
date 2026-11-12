// Siembra de notificaciones por SQL (spec 018, T5): para llenar más de una página de la lista sin lanzar
// decenas de trabajos. Misma regla que `siembra.ts`: solo opera sobre `contapp_e2e` con la conexión de
// migraciones, y cada prueba usa su propio estudio y usuario.
import { Pool } from "pg";
import { BD_E2E } from "./pila/entorno.js";

/**
 * `n` avisos de plan («Estás por llegar al límite de tu plan: usas k de 99 RUC.») sin leer para un usuario,
 * del más antiguo al más nuevo (uno por segundo hacia atrás desde ahora).
 */
export async function sembrarAvisosDePlan(
  tenantId: string,
  usuarioId: string,
  n: number,
): Promise<void> {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (url === undefined || new URL(url).pathname !== `/${BD_E2E}`) {
    throw new Error(`La siembra de avisos solo opera sobre ${BD_E2E}.`);
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      `insert into notificacion (tenant_id, usuario_id, tipo, params, clave_dedupe, creada_en)
       select $1::uuid, $2::uuid, 'plan_limite',
              jsonb_build_object('recurso', 'rucs', 'usado', i, 'limite', 99, 'umbral', 90),
              'e2e-aviso-' || i, date_trunc('milliseconds', now() - (i * interval '1 second'))
         from generate_series(1, $3::int) as i`,
      [tenantId, usuarioId, n],
    );
  } finally {
    await pool.end();
  }
}
