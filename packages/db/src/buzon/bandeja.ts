// STUB de la spec 024 · T3 (rojo). La implementación real (consultas de la bandeja y del detalle de atención) es la tarea T7.
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { Alcance } from "../acceso/alcance";
import type { TxConsulta } from "./errores";
import type { MensajeBuzonFila } from "./lectura";

export type FiltroAtencionBuzon =
  "pendientes" | "atendidos" | "historicos" | "todos";
export type EstadoAtencionBuzon = "pendiente" | "atendido" | "historico";

export interface FiltrosBandejaBuzon {
  clienteId?: string;
  responsableId?: string;
  categoria?: string;
  leido?: boolean;
  atencion?: FiltroAtencionBuzon;
  desde?: string;
  hasta?: string;
  archivados?: boolean;
}

export interface PosicionBandeja {
  fecha: string;
  id: string;
}

export interface AtencionVigente {
  estado: EstadoAtencionBuzon;
  por: { id: string; nombre: string | null } | null;
  en: Date | null;
}

export interface FilaBandejaBuzon extends MensajeBuzonFila {
  fechaTexto: string;
  cliente: { id: string; razonSocial: string; archivado: boolean };
  atencion: AtencionVigente;
}

export interface EventoAtencionBuzon {
  accion: "atendido" | "deshecho";
  comentario: string | null;
  usuario: { id: string; nombre: string | null };
  en: Date;
}

export interface DetalleAtencionBuzon extends AtencionVigente {
  comentario: string | null;
  historial: EventoAtencionBuzon[];
}

export async function listarBandeja(
  _tx: TxConsulta,
  _alcance: Alcance,
  _filtros: FiltrosBandejaBuzon,
  _posicion: PosicionBandeja | null,
  _limite: number,
): Promise<{ filas: FilaBandejaBuzon[]; hayMas: boolean }> {
  throw new Error("no implementado: listarBandeja (spec 024 T7)");
}

export async function detalleAtencion(
  _tx: TxConsulta,
  _mensajeId: string,
): Promise<DetalleAtencionBuzon | null> {
  throw new Error("no implementado: detalleAtencion (spec 024 T7)");
}
