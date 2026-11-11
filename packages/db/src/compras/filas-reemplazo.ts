// Entrega a 012b (spec 014, D-10, CA-14): las dos listas que la prevalidación necesita para generar el archivo de reemplazo.
import { consultar, type TxConsulta } from "./errores";
import { aCompraLeida, COLUMNAS_LEIDA } from "./repositorio";
import type { CompraLeida } from "./tipos";

// Lateral con `offset 0` (como SQL_LEER_VARIAS): la versión se busca por la única (tenant_id, compra_id, n) de cada compra. Con un
// join plano y estadísticas vacías el planificador elegía un nested loop sobre `compra_version_operacion_idx` (O(n²): 20.000
// filas tardaban decenas de segundos, RNF-035). Mismo resultado que UNION_ORIGINAL / UNION_VIGENTE.
const SQL_ORIGINAL = `select ${COLUMNAS_LEIDA} from compra c
  join lateral (select * from compra_version v where v.tenant_id = c.tenant_id and v.compra_id = c.id and v.n = 1 offset 0) v on true
  where c.cliente_id = $1 and c.periodo = $2 and c.origen = 'sire' and c.descartada_en is null order by c.clave, c.id`;
const SQL_VIGENTE = `select ${COLUMNAS_LEIDA} from compra c
  join lateral (select * from compra_version v where v.tenant_id = c.tenant_id and v.compra_id = c.id
    and v.n = c.version_vigente offset 0) v on true
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
 * [012b] Protocolo de consistencia. Las dos listas son DOS sentencias: en `READ COMMITTED` una acción o una descarga que se cuele
 * entre ambas las desajusta (`resumirCambios` lanza si una fila no agregada no está en el original). `withTenant({ foto: true })`
 * no sirve: es `READ ONLY` y 012b debe escribir. Por eso 012b hace, en UNA sola transacción: (1) `fijarEstadoPeriodo(tx, cliente,
 * periodo, desde, 'generado', usuario)`, que toma `compra_periodo FOR UPDATE`, espera a las acciones en curso y hace que las
 * nuevas vean `generado` (409 `periodo_generado`); (2) esta lectura; (3) `prevalidar` y `resumirCambios`. Si algo falla, lanza
 * para revertir también el estado. Las `reglas` de `prevalidar` salen de `leerProveedoresConocidos(tx, cliente, periodo)` y
 * `DICCIONARIO_GLOSAS_BASE`.
 *
 * [012b] `aFila` recibe una `CompraLeida` PLANA, no la `CompraParaReemplazo` anidada (con `MontosComprobante`) que pide
 * `aFilaReemplazo` de `packages/domain`: 012b escribe el adaptador (modelo: `integracion-012.int.spec.ts:77`) o lo sube a `domain`.
 *
 * [012b] DU-25: la razón social de una compra admite hasta 200 caracteres, pero el TXT provisional admite 100; 012b la recorta a
 * 100 al armar el TXT y lo avisa, sin bloquear. Esta lectura devuelve la razón social completa.
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
