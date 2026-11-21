// Lo que R-STD necesita de la BD (spec 025, RF-113; D-8, D-9): el perfil fiscal del cliente (columnas de 0026) y los proveedores con
// regla aprendida activa. El perfil se lee en cada descarga y en cada re-evaluación: cambiarlo después no toca lo guardado (D-9,
// solo inserción), solo lo que se sugiere desde entonces.
import { proveedoresConReglaActiva, type Tx } from "@contapp/db";
import type { PerfilCliente } from "@contapp/domain";

const SQL_PERFIL =
  "select zona, ventas_exoneradas, ventas_mixtas from cliente where id = $1";

/** Perfil del cliente del estudio (la descarga y la re-evaluación ya trabajan con un cliente existente: la FK de la compra lo exige). */
export async function leerPerfilCliente(
  tx: Pick<Tx, "query">,
  clienteId: string,
): Promise<PerfilCliente> {
  const r = await tx.query(SQL_PERFIL, [clienteId]);
  const f = r.rows[0] as {
    zona: string;
    ventas_exoneradas: boolean;
    ventas_mixtas: boolean;
  };
  return {
    zona: f.zona,
    ventasExoneradas: f.ventas_exoneradas,
    ventasMixtas: f.ventas_mixtas,
  };
}

/**
 * Proveedores con regla activa del cliente, sea cual sea el periodo en que se aprendió y el interruptor de R-HIS (la regla
 * desactivada o eliminada no cuenta). El worker no lee `regla_aprendida` directo: usa la función acotada de 0063
 * (`reglas_proveedores_con_regla`), que toma el advisory compartido del estudio y bloquea las reglas FOR SHARE hasta el fin de la
 * transacción (CA-9).
 */
export async function leerProveedoresConRegla(
  tx: Tx,
  clienteId: string,
): Promise<{ tipo: string; numero: string }[]> {
  const proveedores = await proveedoresConReglaActiva(tx, clienteId);
  return proveedores.map((p) => ({ tipo: p.docTipo, numero: p.docNumero }));
}
