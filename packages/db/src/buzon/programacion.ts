/* eslint-disable @typescript-eslint/no-unused-vars -- STUB de T4 (rojo): T11 lo reemplaza y quita esta línea */
// Programación del buzón SOL (spec 023, D-5, D-6): funciones acotadas de 0055. STUB de T4 (rojo): T11 lo implementa.
// `candidatosBuzon` y `encolarBuzonProgramados` van con la `tx` de withTenant del worker; `elevarPrioridadBuzon`, con la del backend.
import type { TxConsulta } from "./errores";

export interface CandidatoBuzon {
  clienteId: string;
  ultimaProgramadaEn: Date | null;
}

export async function candidatosBuzon(
  _tx: TxConsulta,
): Promise<CandidatoBuzon[]> {
  throw new Error("no implementado");
}

/** Ids de los trabajos creados (los clientes que ya no cumplen se omiten). Con lista vacía no consulta y devuelve []. */
export async function encolarBuzonProgramados(
  _tx: TxConsulta,
  _clienteIds: string[],
): Promise<string[]> {
  throw new Error("no implementado");
}

export async function elevarPrioridadBuzon(
  _tx: TxConsulta,
  _trabajoId: string,
): Promise<boolean> {
  throw new Error("no implementado");
}
