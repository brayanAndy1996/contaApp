// Lo que R-STD necesita de la BD (spec 025, RF-113; D-8, D-9): el perfil fiscal del cliente (columnas de 0026) y los proveedores con
// regla aprendida activa. El perfil se lee en cada descarga y en cada re-evaluación: cambiarlo después no toca lo guardado (D-9,
// solo inserción), solo lo que se sugiere desde entonces.
import { reglasHistorialVigentes, type Tx } from "@contapp/db";
import type { PerfilCliente } from "@contapp/domain";

/** Periodo posterior a cualquier otro: `reglas_historial_vigentes` devuelve así todas las reglas vivas y activas del cliente. */
const SIN_LIMITE_DE_PERIODO = "999912";

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
 * Proveedores con regla activa del cliente, sea cual sea el periodo en que se aprendió (la regla desactivada o eliminada no
 * cuenta). El worker no lee `regla_aprendida` directo: usa la función acotada de 021, que toma el advisory compartido del estudio y
 * bloquea las reglas FOR SHARE hasta el fin de la transacción (CA-9) y que devuelve vacío si R-HIS está apagado.
 */
export async function leerProveedoresConRegla(
  tx: Tx,
  clienteId: string,
): Promise<{ tipo: string; numero: string }[]> {
  const reglas = await reglasHistorialVigentes(
    tx,
    clienteId,
    SIN_LIMITE_DE_PERIODO,
  );
  return reglas.map((r) => ({ tipo: r.docTipo, numero: r.docNumero }));
}
