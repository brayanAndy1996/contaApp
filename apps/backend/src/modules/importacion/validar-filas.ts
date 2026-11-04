/* eslint-disable @typescript-eslint/no-unused-vars -- stub de T3: la lógica la escribe T11 */
import type { Rol } from "@contapp/shared";
import type { FilaLeida } from "./tipos.js";

export type CodigoMotivo =
  | "ruc_invalido"
  | "duplicado_en_archivo"
  | "duplicado"
  | "responsable_inexistente"
  | "responsable_no_asignable"
  | "credencial_incompleta"
  | "celda_peligrosa"
  | "cupo_rucs";

export interface Motivo {
  codigo: CodigoMotivo;
  /** Solo en `duplicado`: el RUC existente está archivado (la interfaz sugiere reactivarlo). */
  archivado?: boolean;
}

export interface ContextoValidacion {
  /** RUC que ya existen en el estudio (activos y archivados). */
  existentes: ReadonlyMap<string, { archivado: boolean }>;
  /** Miembros ACTIVOS del estudio por correo en minúsculas (P1 a: el responsable se identifica por correo). */
  miembros: ReadonlyMap<string, { usuarioId: string; rol: Rol }>;
}

export interface FilaValidada {
  n: number;
  ruc: string;
  estado: "valida" | "error";
  motivos: Motivo[];
  tieneSol: boolean;
  tieneSire: boolean;
  /** Usuario responsable resuelto; null si la celda venía vacía o la fila tiene error. */
  responsableId: string | null;
  /** La fila original (con claves): solo para `confirmar`; nunca se serializa hacia el cliente. */
  fila: FilaLeida;
}

export interface VistaPrevia {
  filas: Array<
    Pick<
      FilaValidada,
      "n" | "ruc" | "estado" | "motivos" | "tieneSol" | "tieneSire"
    >
  >;
  validas: number;
  conError: number;
  cupoLibre: number;
  excedentes: number;
}

/** Stub de T3 (la implementa T11). Pura, sin IO. */
export function validarFilas(
  _filas: FilaLeida[],
  _ctx: ContextoValidacion,
): FilaValidada[] {
  throw new Error("no implementado (T11)");
}

/** Stub de T3 (la implementa T11). Proyección sin claves ni usuarios: solo `tieneSol`/`tieneSire`. */
export function aVistaPrevia(
  _filas: FilaValidada[],
  _cupoLibre: number,
): VistaPrevia {
  throw new Error("no implementado (T11)");
}
