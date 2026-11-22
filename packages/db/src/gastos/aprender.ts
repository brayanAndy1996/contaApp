/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T4 (rojo): palabras aprendidas al excluir una compra con XML (spec 027, R-7). Lo implementa T10.
import type { TxConsulta } from "../compras/errores";
import { NO_IMPLEMENTADO } from "./errores";

/** `gnd_aprender`: palabras guardadas y omitidas (ya existían en el estudio), ambas en el orden recibido. */
export async function aprender(
  _tx: TxConsulta,
  _e: {
    clienteId: string;
    compraId: string;
    terminos: { termino: string; categoria: string }[];
  },
): Promise<{ guardadas: string[]; omitidas: string[] }> {
  throw new Error(NO_IMPLEMENTADO);
}
