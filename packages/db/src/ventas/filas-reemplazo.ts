// Entrega al previo y al worker de 012b (D12, plan «Contratos: BD»): las dos listas de ventas que la prevalidación necesita para
// generar el archivo de reemplazo, y la lista de excluidas del previo. SQL estático y parametrizado dentro de withTenant.
import { consultar, type TxConsulta } from "./errores";
import {
  aVenta,
  COLUMNAS_VENTA,
  COLUMNAS_VENTA_CON_EXCLUSION,
  DESDE_VENTA_CON_EXCLUSION,
} from "./lectura";
import type { ExcluidaVenta, VentaFila } from "./tipos";

const SQL_ORIGINAL = `select ${COLUMNAS_VENTA} from venta
  where cliente_id = $1 and periodo = $2 and origen = 'sire' order by clave, id`;

const SQL_VIGENTE = `select ${COLUMNAS_VENTA_CON_EXCLUSION} from ${DESDE_VENTA_CON_EXCLUSION}
  where cliente_id = $1 and periodo = $2 order by clave, id`;

const SQL_EXCLUIDAS = `select v.id as venta_id, v.tipo, v.serie, v.numero, x.motivo
  from venta_exclusion x
  join venta v on v.tenant_id = x.tenant_id and v.id = x.venta_id
  where x.cliente_id = $1 and x.periodo = $2 and x.restaurada_en is null
  order by v.tipo, v.serie, v.numero_n nulls last, v.numero, v.id`;

/**
 * Lo que 012b pasa a su prevalidación: `original` son las ventas que bajaron del SIRE (todas, también las excluidas, con
 * `exclusion: null`); `vigente` son todas las ventas del periodo (sire y manuales) con su exclusión vigente o `null`. Orden por
 * clave y luego id. `aFila` (por lo común `ventaAFila` de `packages/domain`) la inyecta quien llama: `packages/db` no depende del
 * dominio. Los montos y el tipo de cambio llegan como cadenas exactas.
 *
 * Son DOS sentencias: generar las lee en la misma transacción después de fijar `generado` (`fijarEstadoPeriodoVentas`), con el
 * advisory del libro tomado, de modo que ninguna escritura de ventas (excluir y restaurar incluidas) se cuela entre ambas.
 */
export async function leerFilasReemplazoVentas<T>(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  aFila: (venta: VentaFila) => T,
): Promise<{ original: T[]; vigente: T[] }> {
  const original = await consultar(tx, SQL_ORIGINAL, [clienteId, periodo]);
  const vigente = await consultar(tx, SQL_VIGENTE, [clienteId, periodo]);
  return {
    original: original.rows.map((f) => aFila(aVenta(f))),
    vigente: vigente.rows.map((f) => aFila(aVenta(f))),
  };
}

/** Las ventas con exclusión vigente (comprobante y motivo), en el orden de la grilla: la lista de excluidas del previo. */
export async function leerExcluidasVentas(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
): Promise<ExcluidaVenta[]> {
  const r = await consultar(tx, SQL_EXCLUIDAS, [clienteId, periodo]);
  return r.rows.map((f) => ({
    ventaId: f.venta_id,
    tipo: f.tipo,
    serie: f.serie,
    numero: f.numero,
    motivo: f.motivo,
  }));
}
