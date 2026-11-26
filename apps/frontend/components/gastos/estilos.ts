// Estilos compartidos de las tablas de gastos no deducibles (spec 027, T13). Mismo patrón que `tabla-reglas-cliente` (025): en
// escritorio una tabla; a menos de 768 px cada fila se apila y cada celda lleva su etiqueta de columna en `data-etiqueta`, sin
// scroll interior que esconda acciones. Solo tokens de `app/globals.css`.

/** Celda: en escritorio, tabla; a menos de 768 px, bloque con la etiqueta de su columna delante. */
export const CELDA =
  "min-w-0 break-words px-3 py-2 align-top max-md:flex max-md:gap-2 max-md:px-0 max-md:py-1 max-md:before:w-28 max-md:before:shrink-0 max-md:before:font-semibold max-md:before:text-tinta-suave max-md:before:content-[attr(data-etiqueta)]";
export const CABECERA = "px-3 py-2";
/** Fila: en celular, una tarjeta por palabra. */
export const FILA =
  "align-top max-md:mb-3 max-md:flex max-md:flex-col max-md:rounded-control max-md:border max-md:border-linea max-md:bg-hoja max-md:p-3 max-md:shadow-tarjeta";
/** Contenedor de la tabla: la tarjeta solo en escritorio (en celular son tarjetas por fila). */
export const MARCO_TABLA = "min-w-0 md:overflow-hidden md:rounded-tarjeta md:border md:border-linea md:bg-hoja md:shadow-tarjeta";
