// STUB de T4 (tester): solo tipos del contrato (plan 011). T9 lo reemplaza con la versión real.
import type { ColumnaCompra, Destino, MontosComprobante } from "../comprobante/index";
import type { Money, Moneda, TipoCambio } from "../dinero/index";
import type { DiccionarioGlosas } from "../texto/index";

export type CodigoRegla = "R-ISC" | "R-MIX" | "R-RED" | "R-NEW" | "R-GP";
export const ORDEN_REGLAS: readonly CodigoRegla[] = ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP"];
export interface DocProveedor { readonly tipo: string; readonly numero: string }
export interface IdComprobante { readonly tipo: string; readonly serie: string; readonly numero: string }
export interface ResumenXml {
  readonly proveedor: DocProveedor; readonly comprobante: IdComprobante; readonly moneda: Moneda;
  readonly gravado: Money; readonly igv: Money; readonly noGravado: Money;
  readonly isc: Money; readonly icbper: Money; readonly total: Money;
  readonly glosas: readonly string[];
}
export interface FilaEvaluable {
  readonly id: string;
  readonly proveedor: DocProveedor; readonly comprobante: IdComprobante;
  readonly montos: MontosComprobante;
  readonly origenUsd?: { readonly montos: MontosComprobante; readonly tipoCambio: TipoCambio };
  readonly xml?: ResumenXml;
}
export interface ContextoReglas {
  readonly proveedoresConocidos: readonly DocProveedor[];
  readonly proveedoresIsc: readonly DocProveedor[];
  readonly diccionario: DiccionarioGlosas;
}
export type Sugerencia =
  | { tipo: "mover"; origen: ColumnaCompra; destino: ColumnaCompra; monto: Money }
  | { tipo: "separar"; columnaBi: ColumnaCompra; min: Money; max: Money; estimado: Money; exacto: Money | null }
  | { tipo: "ajustar"; valores: Readonly<Partial<Record<ColumnaCompra | "total", Money>>> }
  | { tipo: "clasificar" }
  | { tipo: "excluir"; palabra: string; categoria: string };
export interface Hallazgo {
  readonly filaId: string; readonly regla: CodigoRegla; readonly destino: Destino | null;
  readonly explicacion: string;
  readonly sugerencia: Sugerencia | null;
  readonly requiereConfirmacion: boolean;
  readonly dato: "gravado" | "destino" | null;
  readonly lecturas: Readonly<Partial<Record<ColumnaCompra | "total", Money>>>;
}
export interface Aviso { readonly filaId: string; readonly codigo: "XML_AJENO" | "XML_MONEDA"; readonly explicacion: string }
export type Confirmacion = { gravado: Money } | { destino: Destino };
