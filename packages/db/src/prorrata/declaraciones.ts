/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T4 (rojo): repositorio de declaraciones del PDT 621 y de obtenciones (spec 026, D-3, D-4). Lo implementa T10.
import type { TxConsulta } from "../compras/errores";
import { NO_IMPLEMENTADO } from "./errores";

/** Una presentación del PDT 621: montos como cadenas decimales («1000.50»), `numeroOrden` como cadena de 1 a 15 dígitos. */
export interface DeclaracionNueva {
  periodo: string;
  numeroOrden: string;
  fechaPresentacion: string;
  tipo: "original" | "rectificatoria";
  ventasGravadasBase: string;
  ventasGravadasIgv: string;
  exportaciones: string;
  noGravadas: string;
  igvAdquisicionesDg: string;
  igvAdquisicionesDgng: string;
  prorrataUsada: string | null;
}

export interface DeclaracionFila extends DeclaracionNueva {
  obtencionId: string;
}

export interface ObtencionFila {
  id: string;
  periodoHasta: string;
  periodosLeidos: string[];
  periodosSinDeclaracion: string[];
  nuevas: number;
  trabajoId: string | null;
  obtenidaEn: Date;
}

export async function leerDeclaraciones(
  _tx: TxConsulta,
  _clienteId: string,
  _periodos: string[],
): Promise<DeclaracionFila[]> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function leerUltimaObtencion(
  _tx: TxConsulta,
  _clienteId: string,
  _periodoHasta: string,
): Promise<ObtencionFila | null> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function registrarDeclaraciones(
  _tx: TxConsulta,
  _e: {
    clienteId: string;
    trabajoId: string;
    periodoHasta: string;
    leidos: string[];
    sinDeclaracion: string[];
    declaraciones: DeclaracionNueva[];
  },
): Promise<number> {
  throw new Error(NO_IMPLEMENTADO);
}
