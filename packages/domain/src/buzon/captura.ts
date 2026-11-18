// Spec 023 (CA-3, CA-6, P-5): plan de captura por página y decisión de aviso. Sin IO.

export const TOPE_MENSAJES_CAPTURA = 200;
export const MAX_PAGINAS_CAPTURA = 20;
export const DIAS_AVISO_PRIMERA_SINCRONIZACION = 30;
/**
 * Cursor pendiente cuando la captura se corta sin un cursor del portal a mano (H-023-2-1): la captura siempre vuelve a
 * empezar por la primera página (con paginación por desplazamiento los cursores se corren), así que el valor guardado solo
 * dice «hay relleno pendiente».
 */
export const CURSOR_RELLENO = "relleno";

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
  /**
   * Páginas con algún mensaje nuevo ya leídas en esta captura (sin contar esta). Las de relleno que solo traen conocidos
   * no cuentan para `MAX_PAGINAS_CAPTURA` (H-023-2-3): si contaran, un portal de páginas chicas nunca terminaría la primera
   * sincronización.
   */
  readonly paginasLeidas: number;
  /**
   * El cliente ya llegó alguna vez al final de su buzón. Mientras no (`false`), la captura no se detiene en el primer
   * conocido: lo que hay detrás puede faltar (captura anterior cortada, H-023-2-1). Sin el dato se toma como sincronizado.
   */
  readonly sincronizado?: boolean;
  /**
   * Ids de SUNAT ya vistos en las páginas anteriores de ESTA captura. Con paginación por desplazamiento un mensaje que llega
   * a mitad de la captura corre las páginas y el último de una reaparece en la siguiente (H-023-2-2): se salta, no termina.
   */
  readonly vistos?: ReadonlySet<string>;
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
 * - Un id ya visto en una página anterior de esta captura se salta (paginación corrida, H-023-2-2). Una página que no
 *   trae ninguno sin ver corta la captura con relleno pendiente (el portal se repite).
 * - Un conocido solo actualiza el leído en SUNAT. Sin relleno (ni `cursorPendiente` de una captura anterior cortada ni
 *   cliente sin sincronizar), el primer conocido termina la captura: lo que sigue ya se tiene.
 * - Un nuevo se acepta mientras no se llegue a `TOPE_MENSAJES_CAPTURA` en esta captura; el que ya
 *   no cabe corta la captura y la página se vuelve a pedir (`cursorActual`) en la siguiente.
 * - Al terminar la página: sin `siguiente` → sincronizado; en la página `MAX_PAGINAS_CAPTURA` o
 *   con el tope justo lleno → corte con `siguiente` como cursor pendiente.
 * Un corte siempre deja un cursor pendiente no nulo (`CURSOR_RELLENO` si no hay otro): sin él, la captura siguiente se
 * detendría en el primer conocido y lo que faltaba no se capturaría nunca (H-023-2-1).
 * Quien pide las páginas usa un `limite` ≤ `TOPE_MENSAJES_CAPTURA`: así un corte a mitad de
 * página nunca ocurre en la primera, que no tiene cursor propio.
 */
export function planificarCaptura(
  estado: EstadoCaptura,
  pagina: PaginaListado,
  conocidos: ReadonlySet<string>,
): PlanPagina {
  const relleno =
    estado.cursorPendiente !== null || estado.sincronizado === false;
  const cupo = Math.max(0, TOPE_MENSAJES_CAPTURA - estado.nuevosAcumulados);
  const nuevos: MensajeListado[] = [];
  const actualizar: { idSunat: string; leidoEnSunat: boolean }[] = [];
  const vistos = new Set<string>();
  const anteriores = estado.vistos ?? new Set<string>();
  let sinVer = 0;

  for (const m of pagina.mensajes) {
    if (vistos.has(m.idSunat)) continue;
    vistos.add(m.idSunat);
    if (anteriores.has(m.idSunat)) continue;
    sinVer += 1;
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
        siguienteCursor:
          estado.cursorActual ?? pagina.siguiente ?? CURSOR_RELLENO,
        terminada: true,
        sincronizado: false,
      };
    }
    nuevos.push(m);
  }

  if (pagina.mensajes.length > 0 && sinVer === 0 && pagina.siguiente !== null) {
    // Todo repetido: el portal se repite o la página se corrió entera. Se corta con relleno pendiente.
    return {
      nuevos,
      actualizar,
      siguienteCursor: pagina.siguiente,
      terminada: true,
      sincronizado: false,
    };
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

/** Años que se aceptan en la fecha de un mensaje; fuera de ellos la fecha es ilegible (H-023-2-5). */
const ANIO_MINIMO = 1900;
const ANIO_MAXIMO = 9999;
/** ISO 8601 con hora y zona, como lo entrega el puerto (`MensajeListado.fecha`). */
const FECHA_ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Fecha con la que se guarda un mensaje (H-023-2-5, decisión de producto): la del portal si es ISO 8601 con zona y de un
 * año entre 1900 y 9999; si no (texto libre, «dd/mm/aaaa», sin zona, fuera de rango), la de la captura (`ahora`, reloj de
 * la BD). Así una fecha ilegible no tumba la captura, y un crítico con ella se avisa (`debeAvisar` con fecha = ahora).
 */
export function fechaMensaje(fecha: string, ahora: Date): Date {
  if (!FECHA_ISO.test(fecha)) return new Date(ahora.getTime());
  const t = Date.parse(fecha);
  if (Number.isNaN(t)) return new Date(ahora.getTime());
  const anio = new Date(t).getUTCFullYear();
  if (anio < ANIO_MINIMO || anio > ANIO_MAXIMO) return new Date(ahora.getTime());
  return new Date(t);
}

/**
 * Crítico y (cliente ya sincronizado o fecha ≥ ahora − 30 días). `ahora` es el reloj de la BD (H-023-2-4): el trigger de
 * 0056 mide la misma regla con `clock_timestamp()`. Una fecha ilegible de un crítico
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
