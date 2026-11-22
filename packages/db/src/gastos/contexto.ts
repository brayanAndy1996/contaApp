/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T4 (rojo): lector único del contexto de R-GP (spec 027, D-5). Lo implementa T10.
import type { TxConsulta } from "../compras/errores";
import { NO_IMPLEMENTADO } from "./errores";

/** Documento del proveedor tal como lo guarda `compra` (`doc_tipo`, `doc_numero`). */
export interface ProveedorDoc {
  tipo: string;
  numero: string;
}

export interface PalabraContexto {
  palabra: string;
  categoria: string;
  excepciones: string[];
}

/** Datos planos (sin `domain`): el diccionario efectivo lo arma el dominio con `crearDiccionarioEfectivo`. */
export interface ContextoGastosLeido {
  /** 1..20; 3 si el estudio no fijó uno. */
  umbral: number;
  /** Palabras globales activas, por palabra ascendente. */
  globales: PalabraContexto[];
  /** Palabras globales que el estudio desactivó, ascendentes. */
  desactivadas: string[];
  /** Propias activas del estudio, por palabra ascendente. */
  propias: PalabraContexto[];
  ciiuCliente: string | null;
  /** Una entrada por proveedor pedido (sin repetir, en su orden); `ciiu` null sin caché o «sin dato». */
  ciiuProveedores: { proveedor: ProveedorDoc; ciiu: string | null }[];
  categoriasCliente: { permitidas: string[]; quitadas: string[] };
  /** Una entrada por proveedor pedido (sin repetir, en su orden), con ceros si no tiene compras. */
  historial: {
    proveedor: ProveedorDoc;
    aceptadas6: number;
    excluidas6: number;
    excluidas12: number;
  }[];
}

export async function leerContextoGastos(
  _tx: TxConsulta,
  _e: { clienteId: string; periodo: string; proveedores: ProveedorDoc[] },
): Promise<ContextoGastosLeido> {
  throw new Error(NO_IMPLEMENTADO);
}

/** Descripciones de los ítems del XML vigente de la compra, en orden; `null` sin XML o si la compra no es visible. */
export async function leerGlosasCompra(
  _tx: TxConsulta,
  _compraId: string,
): Promise<string[] | null> {
  throw new Error(NO_IMPLEMENTADO);
}
