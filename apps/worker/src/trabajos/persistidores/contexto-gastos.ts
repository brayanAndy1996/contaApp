/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T5 (rojo): contexto de R-GP del estudio para la descarga, el XML, 012b y «Volver a evaluar» (spec 027, D-5). Lo implementa T11.
import type { Tx } from "@contapp/db";
import type { ContextoGastos } from "@contapp/domain";

/** Documento del proveedor tal como lo guarda `compra`. */
export interface ProveedorGastos {
  tipo: string;
  numero: string;
}

/** Devuelve el `ContextoGastos` del dominio (diccionario efectivo, umbral, CIIU, ajuste de categorías e historial). */
export async function contextoGastos(
  _tx: Tx,
  _clienteId: string,
  _periodo: string,
  _proveedores: readonly ProveedorGastos[],
): Promise<ContextoGastos> {
  throw new Error("spec 027 no implementada: contextoGastos (T11)");
}
