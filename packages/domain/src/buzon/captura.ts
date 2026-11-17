// Spec 023 (CA-3, CA-6, P-5): plan de captura por página y decisión de aviso. Sin IO.

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


const DIA_MS = 86_400_000;

/**
 * Recorre una página de lo reciente a lo antiguo:
 * - Un conocido solo actualiza el leído en SUNAT. Sin `cursorPendiente` (no hay relleno de una
 *   captura anterior cortada), el primer conocido termina la captura: lo que sigue ya se tiene.
 * - Un nuevo se acepta mientras no se llegue a `TOPE_MENSAJES_CAPTURA` en esta captura; el que ya
 *   no cabe corta la captura y la página se vuelve a pedir (`cursorActual`) en la siguiente.
 * - Al terminar la página: sin `siguiente` → sincronizado; en la página `MAX_PAGINAS_CAPTURA` o
 *   con el tope justo lleno → corte con `siguiente` como cursor pendiente.
 * Quien pide las páginas usa un `limite` ≤ `TOPE_MENSAJES_CAPTURA`: así un corte a mitad de
 * página nunca ocurre en la primera, que no tiene cursor propio.
 */
export function planificarCaptura(
  estado: EstadoCaptura,
  pagina: PaginaListado,
  conocidos: ReadonlySet<string>,
): PlanPagina {
  const relleno = estado.cursorPendiente !== null;
  const cupo = Math.max(0, TOPE_MENSAJES_CAPTURA - estado.nuevosAcumulados);
  const nuevos: MensajeListado[] = [];
  const actualizar: { idSunat: string; leidoEnSunat: boolean }[] = [];
  const vistos = new Set<string>();

  for (const m of pagina.mensajes) {
    if (vistos.has(m.idSunat)) continue;
    vistos.add(m.idSunat);
    if (conocidos.has(m.idSunat)) {
      actualizar.push({ idSunat: m.idSunat, leidoEnSunat: m.leidoEnSunat });
      if (!relleno) {
        return {
          nuevos,
          actualizar,
          siguienteCursor: null,
          terminada: true,
          sincronizado: false,
        };
      }
      continue;
    }
    if (nuevos.length >= cupo) {
      // No cabe: se vuelve a leer esta página en la captura siguiente (los ya aceptados serán
      // conocidos). Sin cursor propio (primera página), el siguiente es lo único que queda.
      return {
        nuevos,
        actualizar,
        siguienteCursor: estado.cursorActual ?? pagina.siguiente,
        terminada: true,
        sincronizado: false,
      };
    }
    nuevos.push(m);
  }

  if (pagina.siguiente === null) {
    return {
      nuevos,
      actualizar,
      siguienteCursor: null,
      terminada: true,
      sincronizado: true,
    };
  }
  const cortada =
    estado.paginasLeidas + 1 >= MAX_PAGINAS_CAPTURA ||
    estado.nuevosAcumulados + nuevos.length >= TOPE_MENSAJES_CAPTURA;
  return {
    nuevos,
    actualizar,
    siguienteCursor: pagina.siguiente,
    terminada: cortada,
    sincronizado: false,
  };
}

/**
 * Crítico y (cliente ya sincronizado o fecha ≥ ahora − 30 días). Una fecha ilegible de un crítico
 * avisa: ante la duda, se avisa.
 */
export function debeAvisar(p: {
  readonly critico: boolean;
  readonly fecha: Date;
  readonly sincronizadoEn: Date | null;
  readonly ahora: Date;
}): boolean {
  if (!p.critico) return false;
  if (p.sincronizadoEn !== null) return true;
  const fecha = p.fecha.getTime();
  if (Number.isNaN(fecha)) return true;
  return (
    fecha >= p.ahora.getTime() - DIAS_AVISO_PRIMERA_SINCRONIZACION * DIA_MS
  );
}
