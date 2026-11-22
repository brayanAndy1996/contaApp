/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T4 (rojo): categorías permitidas y quitadas por cliente (spec 027, R-13). Lo implementa T10.
import type { TxConsulta } from "../compras/errores";
import { NO_IMPLEMENTADO } from "./errores";

export interface CategoriasClienteLeidas {
  /** Clase CIIU del cliente en la caché del estudio, o `null`. */
  ciiu: string | null;
  permitidas: string[];
  quitadas: string[];
  /** 0 si el estudio nunca las fijó. */
  version: number;
}

/** `null` si el cliente no existe, es de otro estudio o el id está mal formado. */
export async function leerCategoriasCliente(
  _tx: TxConsulta,
  _clienteId: string,
): Promise<CategoriasClienteLeidas | null> {
  throw new Error(NO_IMPLEMENTADO);
}

/** `gnd_cliente_categorias_fijar`: devuelve la versión nueva. */
export async function fijarCategoriasCliente(
  _tx: TxConsulta,
  _e: {
    clienteId: string;
    permitidas: string[];
    quitadas: string[];
    version: number;
  },
): Promise<number> {
  throw new Error(NO_IMPLEMENTADO);
}
