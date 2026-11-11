// Estado del periodo de ventas (spec 012b, P-1, P-9, D5): abierto, revisado o generado; la ausencia de fila equivale a `abierto`.
// Mismo contrato que el estado de compras (014) sobre su propia tabla `venta_periodo`: el estado de ventas es independiente.
// Orden de bloqueo: tras el advisory del libro (`bloquearPeriodoLibro`), las escrituras de ventas (también excluir y restaurar)
// toman `venta_periodo FOR SHARE` y generar, revisar y reabrir lo toman `FOR UPDATE`.
import { consultar, type TxConsulta } from "./errores";
import type { EstadoPeriodoVenta, EstadoPeriodoVentas } from "./tipos";

const SQL_CREAR = `insert into venta_periodo (cliente_id, periodo, estado) values ($1, $2, 'abierto')
  on conflict (tenant_id, cliente_id, periodo) do nothing`;
const COLUMNAS = `estado, marcado_por, marcado_en`;
const SQL_LEER = `select ${COLUMNAS} from venta_periodo where cliente_id = $1 and periodo = $2`;
const SQL_LEER_COMPARTIDO = `${SQL_LEER} for share`;
const SQL_LEER_EXCLUSIVO = `${SQL_LEER} for update`;
const SQL_FIJAR = `update venta_periodo set estado = $3, marcado_por = $4, marcado_en = now()
  where cliente_id = $1 and periodo = $2 returning ${COLUMNAS}`;

const aEstado = (f: {
  estado: EstadoPeriodoVentas;
  marcado_por: string | null;
  marcado_en: Date | null;
}): EstadoPeriodoVenta => ({
  estado: f.estado,
  marcadoPor: f.marcado_por,
  marcadoEn: f.marcado_en,
});

const ABIERTO: EstadoPeriodoVenta = {
  estado: "abierto",
  marcadoPor: null,
  marcadoEn: null,
};

/**
 * Estado del periodo de ventas. Con `compartido: true` crea la fila si falta (`INSERT … ON CONFLICT DO NOTHING`) y la lee con
 * `FOR SHARE` (primer bloqueo de las escrituras de ventas tras el advisory del libro); sin él solo lee y no crea nada.
 */
export async function leerEstadoPeriodoVentas(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  opciones: { compartido?: boolean } = {},
): Promise<EstadoPeriodoVenta> {
  if (opciones.compartido === true)
    await consultar(tx, SQL_CREAR, [clienteId, periodo]);
  const r = await consultar(
    tx,
    opciones.compartido === true ? SQL_LEER_COMPARTIDO : SQL_LEER,
    [clienteId, periodo],
  );
  return r.rows[0]
    ? aEstado(r.rows[0] as Parameters<typeof aEstado>[0])
    : ABIERTO;
}

/**
 * Compare-and-set bajo `FOR UPDATE`: pasa de `desde` a `hacia` y marca quién y cuándo; devuelve `null` si el estado vigente no era
 * `desde`. Sin fila previa, el estado vigente es `abierto`. Un estado fuera de los tres valores lo rechaza el CHECK (VentasRepoError
 * 23514). Con el rol del worker, el trigger `periodo_worker_acotado` solo deja marcar `generado` desde `abierto` o `revisado`.
 * Generar fija `generado` PRIMERO, en la misma transacción en la que luego lee las filas (`leerFilasReemplazoVentas`).
 */
export async function fijarEstadoPeriodoVentas(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  desde: EstadoPeriodoVentas,
  hacia: EstadoPeriodoVentas,
  usuarioId: string,
): Promise<EstadoPeriodoVenta | null> {
  await consultar(tx, SQL_CREAR, [clienteId, periodo]);
  const actual = await consultar(tx, SQL_LEER_EXCLUSIVO, [clienteId, periodo]);
  if (actual.rows[0]?.estado !== desde) return null;
  const r = await consultar(tx, SQL_FIJAR, [
    clienteId,
    periodo,
    hacia,
    usuarioId,
  ]);
  return aEstado(r.rows[0] as Parameters<typeof aEstado>[0]);
}
