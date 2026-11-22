/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T4 (rojo): meses manuales versionados y su historial (spec 026, R-5, D-4). Lo implementa T10.
import type { TxConsulta } from "../compras/errores";
import type { DeclaracionFila } from "./declaraciones";
import { NO_IMPLEMENTADO } from "./errores";

export interface ManualFila {
  periodo: string;
  version: number;
  accion: "guardado" | "eliminado";
  /** `null` en las tres si la acción es `eliminado`. */
  gravadas: string | null;
  exportaciones: string | null;
  noGravadas: string | null;
  motivo: string;
  autor: { id: string; nombre: string };
  creadoEn: Date;
}

export async function leerManuales(
  _tx: TxConsulta,
  _clienteId: string,
  _periodos: string[],
): Promise<ManualFila[]> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function leerHistorialMes(
  _tx: TxConsulta,
  _clienteId: string,
  _periodo: string,
): Promise<{ declaraciones: DeclaracionFila[]; manual: ManualFila[] }> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function guardarMesManual(
  _tx: TxConsulta,
  _e: {
    clienteId: string;
    periodo: string;
    gravadas: string;
    exportaciones: string;
    noGravadas: string;
    motivo: string;
    version: number;
  },
): Promise<number> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function eliminarMesManual(
  _tx: TxConsulta,
  _e: { clienteId: string; periodo: string; motivo: string; version: number },
): Promise<number> {
  throw new Error(NO_IMPLEMENTADO);
}
