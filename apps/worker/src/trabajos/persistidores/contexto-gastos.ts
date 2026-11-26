// Contexto de R-GP del estudio para la descarga, el XML, 012b y «Volver a evaluar» (spec 027, D-5). Un solo lector: `leerContextoGastos`
// de `packages/db` (solo lectura, 2 consultas, con la RLS del estudio) y el diccionario efectivo del dominio. Se arma dentro de la
// transacción de quien lo usa; nunca escribe.
import { leerContextoGastos, type Tx } from "@contapp/db";
import { crearDiccionarioEfectivo, type ContextoGastos } from "@contapp/domain";

/** Documento del proveedor tal como lo guarda `compra`. */
export interface ProveedorGastos {
  tipo: string;
  numero: string;
}

// La misma gramática que valida el dominio (`normalizarDocumento`): un documento guardado fuera de ella no entra al contexto (ahí
// lanzaría y tumbaría el trabajo) y solo deja de servir para el CIIU y el historial.
const TIPO_DOC = /^[0-9A-Z]$/;
const NUMERO_DOC = /^[0-9A-Za-z-]{1,15}$/;

const valido = (p: ProveedorGastos): boolean => TIPO_DOC.test(p.tipo) && NUMERO_DOC.test(p.numero);

/** Devuelve el `ContextoGastos` del dominio (diccionario efectivo, umbral, CIIU, ajuste de categorías e historial). */
export async function contextoGastos(
  tx: Tx,
  clienteId: string,
  periodo: string,
  proveedores: readonly ProveedorGastos[],
): Promise<ContextoGastos> {
  const l = await leerContextoGastos(tx, {
    clienteId,
    periodo,
    proveedores: proveedores.filter(valido).map((p) => ({ tipo: p.tipo, numero: p.numero })),
  });
  return {
    diccionario: crearDiccionarioEfectivo({
      globales: l.globales.map((g) => ({ ...g, activa: true })),
      desactivadas: l.desactivadas,
      propias: l.propias.map((p) => ({ ...p, activa: true })),
    }),
    umbral: l.umbral,
    ciiuCliente: l.ciiuCliente,
    ciiuProveedores: l.ciiuProveedores,
    categoriasCliente: l.categoriasCliente,
    historial: l.historial,
  };
}
