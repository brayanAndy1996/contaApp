// Estado del periodo de compras (spec 014, D-9, DU-4): abierto, revisado o generado. La ausencia de fila equivale a `abierto`.
// Orden de bloqueo: tras el advisory de la descarga, `compra_periodo` es lo primero que toman las acciones (`FOR SHARE`) y lo que
// toma un cambio de estado (`FOR UPDATE`): una acción en curso retiene el cambio y un cambio en curso retiene a la acción.
import { consultar, type TxConsulta } from "./errores";
import type { EstadoPeriodo, EstadoPeriodoCompras } from "./tipos";

const SQL_CREAR = `insert into compra_periodo (cliente_id, periodo, estado) values ($1, $2, 'abierto')
  on conflict (tenant_id, cliente_id, periodo) do nothing`;
const COLUMNAS = `estado, marcado_por, marcado_en`;
const SQL_LEER = `select ${COLUMNAS} from compra_periodo where cliente_id = $1 and periodo = $2`;
const SQL_LEER_COMPARTIDO = `${SQL_LEER} for share`;
const SQL_LEER_EXCLUSIVO = `${SQL_LEER} for update`;
const SQL_FIJAR = `update compra_periodo set estado = $3, marcado_por = $4, marcado_en = now()
  where cliente_id = $1 and periodo = $2 returning ${COLUMNAS}`;

const aEstado = (f: {
  estado: EstadoPeriodoCompras;
  marcado_por: string | null;
  marcado_en: Date | null;
}): EstadoPeriodo => ({
  estado: f.estado,
  marcadoPor: f.marcado_por,
  marcadoEn: f.marcado_en,
});

const ABIERTO: EstadoPeriodo = {
  estado: "abierto",
  marcadoPor: null,
  marcadoEn: null,
};

/**
 * Estado del periodo. Con `compartido: true` crea la fila si falta (`INSERT … ON CONFLICT DO NOTHING`) y la lee con `FOR SHARE`
 * (primer bloqueo de las acciones tras el advisory de la descarga); sin él solo lee y no crea nada.
 */
export async function leerEstadoPeriodo(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  opciones: { compartido?: boolean } = {},
): Promise<EstadoPeriodo> {
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
 * `desde` (otro lo cambió antes). Sin fila previa, el estado vigente es `abierto`. Un estado fuera de los tres valores lo rechaza
 * el CHECK de la tabla (ComprasRepoError 23514). Lo usan el backend (revisar y reabrir) y 012b (marcar `generado`).
 */
export async function fijarEstadoPeriodo(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  desde: EstadoPeriodoCompras,
  hacia: EstadoPeriodoCompras,
  usuarioId: string,
): Promise<EstadoPeriodo | null> {
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
