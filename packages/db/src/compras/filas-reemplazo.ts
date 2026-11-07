// Entrega a 012b (spec 014, D-10, CA-14): las dos listas que la prevalidación necesita para generar el archivo de reemplazo.
import { consultar, type TxConsulta } from "./errores";
import {
  aCompraLeida,
  COLUMNAS_LEIDA,
  UNION_ORIGINAL,
  UNION_VIGENTE,
} from "./repositorio";
import type { CompraLeida } from "./tipos";

const SQL_ORIGINAL = `select ${COLUMNAS_LEIDA} from ${UNION_ORIGINAL}
  where c.cliente_id = $1 and c.periodo = $2 and c.origen = 'sire' and c.descartada_en is null order by c.clave, c.id`;
const SQL_VIGENTE = `select ${COLUMNAS_LEIDA} from ${UNION_VIGENTE}
  where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null order by c.clave, c.id`;

/**
 * Lo que 012b pasa a su prevalidación para el reemplazo: `original` es la versión 1 de las compras que bajaron del SIRE (también las
 * que después se excluyeron, para que la prevalidación vea el lado original completo); `vigente` es la versión vigente de las
 * compras vivas, sire y agregadas, con las excluidas marcadas `excluida = true` (las descartadas no). Orden por clave.
 *
 * `aFila` (por lo común `aFilaReemplazo` de `packages/domain`) la inyecta quien llama, porque `packages/db` no depende del
 * dominio; lo que devuelva pasa tal cual. Los montos y el tipo de cambio llegan como cadenas exactas; una compra en PEN trae
 * `tipoCambio: null`.
 *
 * [012b] Quien llame a `prevalidar` con estas filas debe pasarle SIEMPRE las `reglas` y nunca tomar el `registro` de la petición:
 * el registro de lo que se cambió lo da esta lectura (original frente a vigente), no el cliente HTTP.
 */
export async function leerFilasReemplazo<T>(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  aFila: (compra: CompraLeida) => T,
): Promise<{ original: T[]; vigente: T[] }> {
  const original = await consultar(tx, SQL_ORIGINAL, [clienteId, periodo]);
  const vigente = await consultar(tx, SQL_VIGENTE, [clienteId, periodo]);
  return {
    original: original.rows.map((f) => aFila(aCompraLeida(f))),
    vigente: vigente.rows.map((f) => aFila(aCompraLeida(f))),
  };
}
