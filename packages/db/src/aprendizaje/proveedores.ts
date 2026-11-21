// Proveedores con regla aprendida activa de un cliente (spec 025, T11a; D-8, D-9, CA-9), para R-STD y R-NEW en el worker, que no
// tiene grant sobre `regla_aprendida`. Lee solo por la función acotada de 0063 (`reglas_proveedores_con_regla`, EXECUTE solo
// contapp_worker): las reglas vivas y activas, sea cual sea su periodo y el interruptor de R-HIS, bloqueadas FOR SHARE hasta el fin
// de la transacción. De todo error de `pg` solo se conserva el SQLSTATE (AprendizajeRepoError).
import type { TxConsulta } from "../compras/errores";
import { consultarPorId } from "./importacion";

const SQL_PROVEEDORES = `select doc_tipo, doc_numero from public.reglas_proveedores_con_regla($1::uuid)`;

/** Documento del proveedor de una regla activa. */
export interface ProveedorConRegla {
  docTipo: string;
  docNumero: string;
}

/** Proveedores con regla activa del cliente en el estudio de la `tx` (cliente ajeno, inexistente o id que no es uuid: vacío). */
export async function proveedoresConReglaActiva(
  tx: TxConsulta,
  clienteId: string,
): Promise<ProveedorConRegla[]> {
  const filas = await consultarPorId(tx, clienteId, SQL_PROVEEDORES, [clienteId]);
  return filas.map((f) => ({
    docTipo: f.doc_tipo as string,
    docNumero: f.doc_numero as string,
  }));
}
