/* eslint-disable @typescript-eslint/no-unused-vars -- stub en rojo de T4 (spec 028): T10 lo reemplaza */
// STUB (spec 028, T4 rojo): lo reemplaza T10. Lectura del resumen diario de un usuario (R-13, D-6), en <= 3 consultas.
import type { TxConsulta } from "./errores";

export type EstadoPeriodoResumen = "sin_descargar" | "abierto" | "revisado";

export interface ClienteResumen {
  clienteId: string;
  razonSocial: string;
  /** No históricos con `primera_captura_en` estrictamente posterior a `desde` (atendidos o no). */
  nuevos: number;
  /** De esos nuevos, los críticos. */
  criticosNuevos: number;
  /** Todos los no históricos sin `atendido_en` del cliente (nuevos o anteriores). */
  pendientesAtender: number;
  /** Estado del periodo de compras; null si está `generado`. */
  compras: EstadoPeriodoResumen | null;
  ventas: EstadoPeriodoResumen | null;
}

export interface ParametrosResumen {
  usuarioId: string;
  /** Corte: `corte_hasta` del resumen anterior o ahora - 24 h. */
  desde: Date;
  /** AAAAMM del mes anterior en Lima. */
  periodo: string;
  /** Marca guardada de «todos los clientes»; solo rige para Dueño o Administrador sin asignaciones. */
  todos: boolean;
}

/**
 * Clientes del alcance del usuario (asignados no archivados; todos los no archivados si `todos` rige) que tengan algo que contar:
 * `nuevos > 0` o `compras`/`ventas` distintos de null. Sin orden fijo (el dominio ordena y recorta a 50).
 */
export async function leerResumen(
  _tx: TxConsulta,
  _p: ParametrosResumen,
): Promise<ClienteResumen[]> {
  throw new Error("no implementado: leerResumen");
}
