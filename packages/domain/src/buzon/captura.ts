// STUB (spec 023, T1).
/* eslint-disable @typescript-eslint/no-unused-vars */

export const TOPE_MENSAJES_CAPTURA = 200;
export const MAX_PAGINAS_CAPTURA = 20;
export const DIAS_AVISO_PRIMERA_SINCRONIZACION = 30;

export interface MensajeListado {
  readonly idSunat: string;
  readonly asunto: string;
  readonly remitente: string;
  /** ISO con zona. */
  readonly fecha: string;
  readonly codigoTipo: string | null;
  readonly leidoEnSunat: boolean;
  readonly adjuntos: readonly {
    readonly idSunat: string;
    readonly nombre: string;
  }[];
}

export interface PaginaListado {
  /** De los más recientes a los más antiguos. */
  readonly mensajes: readonly MensajeListado[];
  readonly siguiente: string | null;
}

export interface EstadoCaptura {
  /** Cursor guardado por una captura anterior que se cortó (relleno); `null` si no hay. */
  readonly cursorPendiente: string | null;
  /** Cursor con el que se pidió esta página (`null` = la primera). */
  readonly cursorActual: string | null;
  /** Mensajes nuevos aceptados en las páginas anteriores de esta captura. */
  readonly nuevosAcumulados: number;
  /** Páginas ya leídas en esta captura (sin contar esta). */
  readonly paginasLeidas: number;
}

export interface PlanPagina {
  readonly nuevos: readonly MensajeListado[];
  readonly actualizar: readonly {
    readonly idSunat: string;
    readonly leidoEnSunat: boolean;
  }[];
  /**
   * `terminada` falso: cursor de la página siguiente que hay que pedir.
   * `terminada` verdadero: cursor a guardar como `cursor_pendiente` (la captura se cortó) o
   * `null` (nada pendiente).
   */
  readonly siguienteCursor: string | null;
  readonly terminada: boolean;
  /** Llegó al final del buzón sin cortarse. */
  readonly sincronizado: boolean;
}

export function planificarCaptura(
  _estado: EstadoCaptura,
  _pagina: PaginaListado,
  _conocidos: ReadonlySet<string>,
): PlanPagina {
  throw new Error("no implementado: planificarCaptura");
}

export function debeAvisar(_p: {
  readonly critico: boolean;
  readonly fecha: Date;
  readonly sincronizadoEn: Date | null;
  readonly ahora: Date;
}): boolean {
  throw new Error("no implementado: debeAvisar");
}
