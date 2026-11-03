// Lectura de config_sistema (spec 008, CA-4, D12). Se llama dentro de withSistema (o withTenant): la tabla no tiene
// tenant_id y la app solo la lee. Si la lectura falla, el despachador conserva la última configuración válida.
import type { ColaTrabajo } from "./registro";
import { consultar, type TxConsulta } from "./errores";

export interface ConfigCola {
  cola: ColaTrabajo;
  concurrenciaGlobal: number;
  concurrenciaTenant: number;
  esperaRucMs: number;
  reintentos: number;
  backoffBaseMs: number;
  maxPendientesTenant: number;
}

const SQL_CONFIG = `select cola, concurrencia_global, concurrencia_tenant, espera_ruc_ms, reintentos, backoff_base_ms,
  max_pendientes_tenant from config_sistema order by cola`;

/** Límites por cola (solo las colas con fila). */
export async function leerConfig(
  tx: TxConsulta,
): Promise<Map<ColaTrabajo, ConfigCola>> {
  const r = await consultar(tx, SQL_CONFIG, []);
  const m = new Map<ColaTrabajo, ConfigCola>();
  for (const f of r.rows) {
    m.set(f.cola, {
      cola: f.cola,
      concurrenciaGlobal: Number(f.concurrencia_global),
      concurrenciaTenant: Number(f.concurrencia_tenant),
      esperaRucMs: Number(f.espera_ruc_ms),
      reintentos: Number(f.reintentos),
      backoffBaseMs: Number(f.backoff_base_ms),
      maxPendientesTenant: Number(f.max_pendientes_tenant),
    });
  }
  return m;
}
