/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB de la spec 025 (T4, rojo): solo la firma del contrato; T10 lo reemplaza por la implementación (funciones acotadas de 0062).
import type { TxConsulta } from "../compras/errores";
import type { DestinoRegla } from "../reglas/tipos";

const NO_IMPLEMENTADO = "aprendizaje: no implementado";

export type GrupoCandidatas =
  "propuestas" | "sin_criterio" | "conflicto" | "resueltas";
export type EstadoCandidata =
  "pendiente" | "activada" | "descartada" | "reemplazada";
export type ConflictoCandidata = "ninguno" | "ya_aprendida" | "distinto";
export type MotivoOmitida =
  "conflicto" | "ya_aprendida" | "no_pendiente" | "sin_criterio";

export interface PosicionCandidata {
  docTipo: string;
  docNumero: string;
}

export interface CandidataFila {
  id: string;
  proveedor: { tipo: string; numero: string; razonSocial: string | null };
  destinoPropuesto: DestinoRegla | null;
  conteos: {
    DG: number;
    DGNG: number;
    DNG: number;
    mixto: number;
    total: number;
  };
  periodosConProveedor: number;
  periodosLeidos: number;
  estado: EstadoCandidata;
  destinoElegido: DestinoRegla | null;
  regla: { id: string; destino: DestinoRegla; version: number } | null;
  conflicto: ConflictoCandidata;
}

export async function listarCandidatas(
  _tx: TxConsulta,
  _e: {
    clienteId: string;
    grupo: GrupoCandidatas;
    posicion: PosicionCandidata | null;
    limite: number;
  },
): Promise<{
  candidatas: CandidataFila[];
  siguiente: PosicionCandidata | null;
}> {
  throw new Error(NO_IMPLEMENTADO);
}

export type EntradaActivar =
  | { clienteId: string; items: Array<{ id: string; destino?: DestinoRegla }> }
  | { clienteId: string; todas: string };

export async function activarCandidatas(
  _tx: TxConsulta,
  _e: EntradaActivar,
): Promise<{
  activadas: string[];
  omitidas: Array<{ id: string; motivo: MotivoOmitida }>;
}> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function reemplazarCandidata(
  _tx: TxConsulta,
  _e: {
    clienteId: string;
    candidataId: string;
    destino?: DestinoRegla;
    versionRegla: number;
  },
): Promise<{ reglaId: string } | "regla_cambiada"> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function descartarCandidatas(
  _tx: TxConsulta,
  _e: { clienteId: string; ids: string[] },
): Promise<{ descartadas: string[]; omitidas: string[] }> {
  throw new Error(NO_IMPLEMENTADO);
}
