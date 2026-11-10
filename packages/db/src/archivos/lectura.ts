// Lectura de las versiones generadas (spec 012b, D5, D8, CA-9). Dentro de withTenant: otro estudio no ve nada (RLS) y un id de otro
// cliente, periodo o libro da `null`, igual que uno inexistente.
import { consultar, type TxConsulta } from "./errores";
import {
  aVersion,
  COLUMNAS_VERSION,
  type LibroArchivo,
  type VersionArchivo,
} from "./versiones";

const SQL_LISTAR = `select ${COLUMNAS_VERSION} from archivo_generado
  where cliente_id = $1 and periodo = $2 and libro = $3 order by version desc`;

const SQL_LEER = `select ${COLUMNAS_VERSION} from archivo_generado
  where id = $1 and cliente_id = $2 and periodo = $3 and libro = $4`;

/** Las versiones de (cliente, periodo, libro), mayor versión primero; vacío si no hay. */
export async function listarVersiones(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  libro: LibroArchivo,
): Promise<VersionArchivo[]> {
  const r = await consultar(tx, SQL_LISTAR, [clienteId, periodo, libro]);
  return r.rows.map(aVersion);
}

/** Una versión por id, solo si es del cliente, periodo y libro pedidos (si no, `null`). El id llega ya validado como uuid. */
export async function leerVersion(
  tx: TxConsulta,
  archivoId: string,
  filtro: { clienteId: string; periodo: string; libro: LibroArchivo },
): Promise<VersionArchivo | null> {
  const r = await consultar(tx, SQL_LEER, [
    archivoId,
    filtro.clienteId,
    filtro.periodo,
    filtro.libro,
  ]);
  return r.rows[0] ? aVersion(r.rows[0]) : null;
}
