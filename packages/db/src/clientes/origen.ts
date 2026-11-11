// Origen de un alta de cliente (spec 017, D-3): el trigger de `cliente.creado` lee `app.origen_cliente` y guarda
// `{origen: 'importacion'}` si vale 'importacion'; cualquier otro valor o vacío es 'manual'. Va con `set_config(..., true)`: vale solo
// dentro de la transacción de withTenant, así la siguiente alta vuelve a ser manual.
import { consultar, type TxConsulta } from "../acceso/errores";

/** Marca que los clientes que cree esta transacción vienen de una importación. */
export async function marcarOrigenImportacion(tx: TxConsulta): Promise<void> {
  await consultar(tx, "select set_config('app.origen_cliente', 'importacion', true)", []);
}
