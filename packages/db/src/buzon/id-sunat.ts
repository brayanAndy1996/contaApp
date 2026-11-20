// Id de SUNAT del mensaje del buzón (spec 023). Es lo que pide el portal al abrir el mensaje: lo usa SOLO el worker. Ninguna
// ruta del backend lo devuelve (D-10). Recibe la `tx` de withTenant y filtra siempre por cliente.
import { consultar, type TxConsulta } from "./errores";

const SQL_ID_SUNAT =
  "select id_sunat from buzon_mensaje where cliente_id = $1::uuid and id = $2::uuid";

/** Id de SUNAT del mensaje del cliente; `null` si no es del cliente o no existe. */
export async function leerIdSunatBuzon(
  tx: TxConsulta,
  clienteId: string,
  mensajeId: string,
): Promise<string | null> {
  const f = (await consultar(tx, SQL_ID_SUNAT, [clienteId, mensajeId]))
    .rows[0];
  return f === undefined ? null : String(f.id_sunat);
}
